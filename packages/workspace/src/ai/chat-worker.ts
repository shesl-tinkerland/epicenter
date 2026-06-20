/**
 * The per-conversation chat worker: the daemon behavior for one hosted transcript
 * child doc (ADR-0024/0025).
 *
 * `attachChatWorker` is the backend-agnostic append loop the always-on worker runs
 * over a conversation transcript. It is parameterized by a {@link ChatStream},
 * the one contract every inference backend speaks:
 *
 * ```txt
 * startStream(messages, signal) => AsyncIterable<StreamChunk>
 * ```
 *
 * A TanStack cloud adapter (`chat({ adapter, messages })`) and a local backend
 * (Ollama / llama.cpp / MLX) look identical to this loop, so swapping the
 * provider is one argument, not a rewrite. The daemon resolves which backend
 * fills it as a priority chain (ADR-0038); the test suite injects its own
 * fixtures the same way.
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
 * stamp), the worker owns the assistant message (text + finish). The doc itself is
 * the lock, so the only in-memory state is the in-flight stream's abort. Teardown
 * (the row removed, or a daemon shutdown) aborts that stream before the body is
 * destroyed and deliberately writes no finish, leaving an interrupted artifact
 * the client can retry, exactly as an evicted worker would.
 *
 * The flush policy (batching deltas into fewer synced transactions) lives in
 * the shared answer core `streamAnswer` (`chat-answer.ts`), which the in-process
 * browser answerer (`chat-browser-answerer.ts`) calls too: the daemon and an
 * open browser tab run this same loop over the doc (ADR-0033). This worker
 * owns triggering, claiming, and the daemon finish policy; the core owns the loop.
 *
 * @module
 */

import type { ModelMessage } from '@tanstack/ai';
import type * as Y from 'yjs';
import type { ChildDocWorkerHandle } from '../document/child-doc-worker.js';
import { type ChatStream, streamAnswer } from './chat-answer.js';
import {
	appendAssistantMessage,
	chatDocToPrompt,
	findUnansweredTurn,
	readChatDocMessages,
} from './chat-doc.js';

/** Cap for provider error text persisted into the doc; details go to logs. */
const FAILED_MESSAGE_MAX_CHARS = 240;

/** One in-flight generation: enough to cancel it durably. */
type InFlightGeneration = {
	generationId: string;
	controller: AbortController;
	writer: ReturnType<typeof appendAssistantMessage>;
};

/**
 * Build the per-body chat worker for one hosted transcript child doc. Pass the
 * body `Y.Doc` and the inference backend as a {@link ChatStream}. Like the server
 * generation path, the worker is a doc-level writer: it reads the transcript with
 * `readChatDocMessages` and appends the assistant message with
 * `appendAssistantMessage`, both directly over the `ydoc` (the layout handle
 * exposes only the client's user-message writer, never the assistant one). The
 * returned handle is what a mount's child-doc worker factory yields.
 *
 * Designation (R, ADR-0025) is NOT the worker's concern. The child-doc observe
 * loop only ever builds this worker for a conversation bound to this daemon's
 * agent (`row.agent === selfAgentId`); a conversation bound to another agent is
 * never hosted here, so the worker unconditionally answers whatever body it is
 * given. The complementary half lives in the browser, which skips its HTTP
 * kickoff unless the conversation is bound to the cloud agent. The two together
 * are what stop the daemon and the cloud HTTP path from both answering one turn.
 */
export function attachChatWorker({
	ydoc,
	startStream,
}: {
	ydoc: Y.Doc;
	startStream: ChatStream;
}): ChildDocWorkerHandle {
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
				// live worker into a second concurrent claim.
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
 * Run the shared answer core, then apply the daemon finish policy. The core
 * drives the loop and hands back the outcome; this wrapper writes the terminal
 * finish, flushing the buffered tail into it.
 *
 * On abort it writes NO finish: a durable cancel already wrote `cancelled` from
 * `onChange`, and a teardown deliberately leaves the message interrupted (its
 * `Y.Doc` may already be torn down). A clean run writes `completed`; a provider
 * error writes `failed` with the capped message.
 */
async function streamReply(
	writer: ReturnType<typeof appendAssistantMessage>,
	startStream: ChatStream,
	prompt: ModelMessage[],
	signal: AbortSignal,
): Promise<void> {
	const { aborted, runError, tail } = await streamAnswer({
		writer,
		startStream,
		prompt,
		signal,
	});
	if (aborted) return;
	writer.finish(
		runError
			? {
					kind: 'failed',
					code: runError.code,
					message: runError.message.slice(0, FAILED_MESSAGE_MAX_CHARS),
				}
			: { kind: 'completed' },
		{ text: tail },
	);
}
