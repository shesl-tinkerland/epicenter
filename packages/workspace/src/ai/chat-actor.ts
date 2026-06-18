/**
 * The per-conversation chat actor: the daemon behavior for one hosted transcript
 * child doc (ADR-0024/0025).
 *
 * `attachChatActor` is the backend-agnostic append loop the always-on actor runs
 * over a conversation transcript. It is parameterized by a {@link ChatStream},
 * the one contract every inference backend speaks:
 *
 * ```txt
 * startStream(messages, signal) => AsyncIterable<StreamChunk>
 * ```
 *
 * A TanStack cloud adapter (`chat({ adapter, messages })`) and a local backend
 * (Ollama / llama.cpp / MLX) look identical to this loop, so swapping the
 * provider is one argument, not a rewrite. The deterministic placeholder reply
 * Zhongwen ships in V0 is just one injected `ChatStream`; the test suite injects
 * its own fixtures the same way.
 *
 * The loop:
 *
 *  - observes the transcript (`onChange` fires once per transaction);
 *  - reconciles the unanswered turn (`findUnansweredTurn`): appends the assistant
 *    message keyed to the turn's client-minted `generationId` (an existence
 *    check, not a lock), then streams the provider's text deltas into its
 *    `Y.Text` and writes a write-once `finish`;
 *  - honors the client-owned durable cancel (`cancelRequestedAt`): mid-stream it
 *    aborts the live stream and writes `finish: cancelled`; a turn cancelled
 *    before it could start is claimed and finished cancelled without streaming;
 *  - never runs two streams for one body at once: while a generation is in
 *    flight it does not claim again (so the createdAt-based active window lapsing
 *    on a slow model cannot trigger a second concurrent stream), and if the turn
 *    it is answering is re-pointed (a retry) or removed it finishes that orphan
 *    cancelled before the re-pointed turn is claimed.
 *
 * Single writer per field: the client owns the user turn (including the cancel
 * stamp), the actor owns the assistant message (text + finish). The doc itself is
 * the lock, so the only in-memory state is the in-flight stream's abort. Teardown
 * (the row removed, or a daemon shutdown) aborts that stream before the body is
 * destroyed and deliberately writes no finish, leaving an interrupted artifact
 * the client can retry, exactly as an evicted worker would.
 *
 * The flush policy (batching deltas into fewer synced transactions) lives in
 * `streamReply`: buffer text and flush at most once per `FLUSH_INTERVAL_MS`, or
 * sooner if the buffer passes `FLUSH_MAX_CHARS`, so a chatty real provider does
 * not emit one transaction per token. The HTTP generation path
 * (`packages/server/src/ai/doc-generation.ts`) keeps its own copy of this policy
 * until C4 deletes that path wholesale; deliberately NOT shared, since coupling
 * to a route slated for deletion is the opposite of a clean break.
 *
 * @module
 */

import { EventType, type ModelMessage, type StreamChunk } from '@tanstack/ai';
import type * as Y from 'yjs';
import type { ChildDocActorHandle } from '../document/child-doc-actor.js';
import {
	appendAssistantMessage,
	chatDocToPrompt,
	findUnansweredTurn,
	readChatDocMessages,
} from './chat-doc.js';

/** Cap for provider error text persisted into the doc; details go to logs. */
const FAILED_MESSAGE_MAX_CHARS = 240;

/** Flush cadence: at most one content transaction per interval... */
const FLUSH_INTERVAL_MS = 75;
/** ...unless the buffered text passes this size first. */
const FLUSH_MAX_CHARS = 512;

/**
 * The one contract every inference backend speaks: take the snapshotted prompt
 * and an abort signal, return an async iterable of text-delta (and error)
 * chunks. A TanStack adapter stream and a local model backend are
 * interchangeable behind it. The backend MUST wire `signal` into the provider
 * call (e.g. `chat({ abortController })`) so a cancel or teardown frees the
 * connection instead of letting the provider keep generating; the actor also
 * stops consuming on abort, but the signal is what actually stops the work.
 */
export type ChatStream = (
	messages: ModelMessage[],
	signal: AbortSignal,
) => AsyncIterable<StreamChunk>;

/** One in-flight generation: enough to cancel it durably. */
type InFlightGeneration = {
	generationId: string;
	controller: AbortController;
	writer: ReturnType<typeof appendAssistantMessage>;
};

/**
 * Build the per-body chat actor for one hosted transcript child doc. Pass the
 * body `Y.Doc` and the inference backend as a {@link ChatStream}. Like the server
 * generation path, the actor is a doc-level writer: it reads the transcript with
 * `readChatDocMessages` and appends the assistant message with
 * `appendAssistantMessage`, both directly over the `ydoc` (the layout handle
 * exposes only the client's user-message writer, never the assistant one). The
 * returned handle is what a mount's child-doc actor factory yields.
 *
 * Designation (R, ADR-0025) is NOT the actor's concern. The child-doc observe
 * loop only ever builds this actor for a conversation bound to this daemon's
 * agent (`row.agent === selfAgentId`); a conversation bound to another agent is
 * never hosted here, so the actor unconditionally answers whatever body it is
 * given. The complementary half lives in the browser, which skips its HTTP
 * kickoff unless the conversation is bound to the cloud agent. The two together
 * are what stop the daemon and the cloud HTTP path from both answering one turn.
 */
export function attachChatActor({
	ydoc,
	startStream,
}: {
	ydoc: Y.Doc;
	startStream: ChatStream;
}): ChildDocActorHandle {
	let inFlight: InFlightGeneration | undefined;

	function stop(): void {
		inFlight?.controller.abort();
		inFlight = undefined;
	}

	return {
		onChange() {
			const messages = readChatDocMessages(ydoc);
			const now = Date.now();

			// Durable cancel, mid-stream: if the live generation's turn now carries a
			// client cancel stamp, abort the stream and write the cancelled finish.
			// This runs before the answer path so it is reached even while the
			// existence-based claim would otherwise short-circuit us.
			if (inFlight) {
				const turn = messages.find(
					(message) =>
						message.role === 'user' &&
						message.generationId === inFlight?.generationId,
				);
				// Stop the in-flight stream cancelled if its turn was cancelled by the
				// client (durable cancel, mid-stream) or superseded: the turn we are
				// answering was re-pointed (a retry re-mints its generationId) or
				// removed, so this stream is stale. Finishing it cancelled stops it
				// counting as a recent unfinished generation; the re-pointed turn is
				// then claimed on the next observe. This runs before the answer path so
				// it is reached even while the existence-based claim would short-circuit.
				if (turn === undefined || turn.cancelRequestedAt !== undefined) {
					inFlight.writer.finish({ kind: 'cancelled' });
					stop();
					return;
				}
				// Otherwise this turn is still streaming. Never run two streams
				// concurrently: the active-generation window is createdAt-based (it
				// exists to detect an evicted cross-process worker) and can lapse
				// while a slow local model is still producing, so it must not trick a
				// live actor into a second concurrent claim.
				return;
			}

			const turn = findUnansweredTurn(messages, now);
			if (!turn) return;

			// Claim by appending the assistant map: this commits the claim atomically
			// within this synchronous onChange. A later (deferred) re-entrant onChange
			// re-reads the committed state and `findUnansweredTurn` short-circuits on
			// the existing id. (Yjs defers observers fired from inside a transaction,
			// so the guard is the single-threaded read-check-append, not synchronous
			// re-entry.)
			const writer = appendAssistantMessage(ydoc, {
				id: turn.generationId,
				createdAt: now,
			});

			// Durable cancel, pre-stream: the turn was cancelled before we could
			// claim it. Record the cancelled finish and do not stream.
			if (turn.cancelRequestedAt !== undefined) {
				writer.finish({ kind: 'cancelled' });
				return;
			}

			const controller = new AbortController();
			const generation: InFlightGeneration = {
				generationId: turn.generationId,
				controller,
				writer,
			};
			inFlight = generation;
			const prompt = chatDocToPrompt(messages);
			void streamReply(writer, startStream, prompt, controller.signal).finally(
				() => {
					if (inFlight === generation) inFlight = undefined;
				},
			);
		},
		[Symbol.dispose]() {
			// Stop an in-flight stream before the body is torn down. No finish: a
			// teardown leaves an interrupted artifact, not a cancellation.
			inFlight?.controller.abort();
		},
	};
}

/**
 * Drive one provider stream into the assistant message: buffer text deltas and
 * flush them on the {@link FLUSH_INTERVAL_MS}/{@link FLUSH_MAX_CHARS} cadence,
 * then write a write-once `completed` (or `failed`) finish that flushes the tail.
 * A signal abort stops the loop and writes NO finish: the caller's `onChange`
 * already wrote
 * `cancelled` for a durable cancel, and a teardown deliberately leaves the
 * message interrupted (and its `Y.Doc` may already be torn down).
 */
async function streamReply(
	writer: ReturnType<typeof appendAssistantMessage>,
	startStream: ChatStream,
	prompt: ModelMessage[],
	signal: AbortSignal,
): Promise<void> {
	let runError: { code: string; message: string } | undefined;
	// Buffer deltas so a chatty provider becomes a few synced transactions, not
	// one per token. lastFlushAt starts at 0 so the first delta flushes at once
	// (the "thinking" marker becomes live text immediately). A still-buffered tail
	// is discarded on abort (the caller writes the terminal finish, not us) and
	// flushed into the finish transaction on normal completion.
	let buffer = '';
	let lastFlushAt = 0;
	try {
		for await (const chunk of startStream(prompt, signal)) {
			if (signal.aborted) return;
			if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
				buffer += chunk.delta;
				const now = Date.now();
				if (
					now - lastFlushAt >= FLUSH_INTERVAL_MS ||
					buffer.length >= FLUSH_MAX_CHARS
				) {
					writer.appendText(buffer);
					buffer = '';
					lastFlushAt = now;
				}
			} else if (chunk.type === EventType.RUN_ERROR) {
				runError = {
					code: chunk.code ?? 'provider-error',
					message: chunk.message,
				};
			}
		}
	} catch (cause) {
		// Aborting the provider stream surfaces as a throw; that path is the
		// caller's cancel/teardown, not a failure.
		if (signal.aborted) return;
		runError = {
			code: 'stream-error',
			message: cause instanceof Error ? cause.message : String(cause),
		};
	}
	if (signal.aborted) return;
	// Final transaction: flush any buffered tail alongside the terminal finish.
	writer.finish(
		runError
			? {
					kind: 'failed',
					code: runError.code,
					message: runError.message.slice(0, FAILED_MESSAGE_MAX_CHARS),
				}
			: { kind: 'completed' },
		{ text: buffer },
	);
}
