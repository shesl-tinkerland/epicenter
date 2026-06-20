/**
 * The shared answer core: one runtime-agnostic loop that sinks a provider
 * stream into a conversation doc.
 *
 * Every answerer in every runtime runs this loop (ADR-0033). They differ only
 * in how they are triggered, where inference runs, and how the doc propagates;
 * the buffer/flush policy and the chunk switch are the same algorithm, so they
 * live here once instead of being copied into each trigger wrapper. The daemon
 * worker (`chat-worker.ts`) and the in-process browser answerer
 * (`chat-browser-answerer.ts`, which reuses the worker) both call
 * {@link streamAnswer}.
 *
 * The core owns the loop and returns an outcome; it never writes the terminal
 * `finish`. The terminal write is the wrapper's: on abort it writes no finish
 * (the cancel path already wrote `cancelled`, a teardown leaves an interrupted
 * artifact the client can retry); a clean run writes `completed`, a provider
 * error `failed`. So the core hands back
 * `{ aborted, runError?, tail }` and the wrapper applies its own finish policy.
 * On a clean run both flush the buffered tail into their finish transaction.
 *
 * The core touches no raw Y types: it writes through the {@link ChatStream}'s
 * deltas and the writer's `appendText`, and `chat-doc.ts` stays the sole owner
 * of the doc layout.
 *
 * @module
 */

import { EventType, type ModelMessage, type StreamChunk } from '@tanstack/ai';
import { extractErrorMessage } from 'wellcrafted/error';
import type { appendAssistantMessage } from './chat-doc.js';

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
 * connection instead of letting the provider keep generating; the core also
 * stops consuming on abort, but the signal is what actually stops the work.
 */
export type ChatStream = (
	messages: ModelMessage[],
	signal: AbortSignal,
) => AsyncIterable<StreamChunk>;

/**
 * A provider error the wrapper turns into a `failed` finish. `cause` is the raw
 * thrown value, present only when the stream threw (not for a `RUN_ERROR`
 * event), so a wrapper can log the original error.
 */
export type StreamAnswerError = {
	code: string;
	message: string;
	cause?: unknown;
};

/**
 * What the loop produced, for the wrapper to finalize. The core never writes the
 * terminal `finish`; the wrapper reads this and applies its own policy.
 */
export type StreamAnswerOutcome = {
	/**
	 * The signal aborted mid-stream. The wrapper owns the terminal write: the
	 * daemon writes nothing (interrupted or already-cancelled), the cloud writes
	 * `cancelled`. `runError` is `undefined` whenever this is true.
	 */
	aborted: boolean;
	/** A `RUN_ERROR` event or a thrown stream error; absent on a clean run. */
	runError?: StreamAnswerError;
	/**
	 * Text buffered but not yet flushed when the loop ended. The wrapper flushes
	 * it into its finish transaction on a clean (or failed) completion.
	 */
	tail: string;
};

/**
 * Drive one provider stream into the assistant message, batching text deltas
 * into a few synced transactions instead of one per token, and hand back the
 * outcome for the caller to finalize.
 *
 * Buffer text and flush at most once per {@link FLUSH_INTERVAL_MS}, or sooner if
 * the buffer passes {@link FLUSH_MAX_CHARS}. `lastFlushAt` starts at 0 so the
 * first delta flushes at once (the "thinking" marker becomes live text
 * immediately). A `RUN_ERROR` event is captured into `runError`; a thrown stream
 * error (when not aborted) becomes a `stream-error` and carries its `cause`. The
 * loop stops the moment `signal` aborts and discards nothing it has not yet
 * returned: the still-buffered `tail` rides back in the outcome for the wrapper
 * to flush or drop.
 */
export async function streamAnswer({
	writer,
	startStream,
	prompt,
	signal,
}: {
	/** The assistant-message writer from {@link appendAssistantMessage}. */
	writer: Pick<ReturnType<typeof appendAssistantMessage>, 'appendText'>;
	/** The inference backend; receives the prompt and the abort signal. */
	startStream: ChatStream;
	/** The snapshotted prompt, frozen by the wrapper (`chatDocToPrompt`). */
	prompt: ModelMessage[];
	/** Aborts on cancel or teardown; the wrapper owns the terminal write. */
	signal: AbortSignal;
}): Promise<StreamAnswerOutcome> {
	let runError: StreamAnswerError | undefined;
	let buffer = '';
	let lastFlushAt = 0;
	try {
		for await (const chunk of startStream(prompt, signal)) {
			if (signal.aborted) break;
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
		// wrapper's cancel/teardown, not a failure.
		if (!signal.aborted) {
			runError = {
				code: 'stream-error',
				message: extractErrorMessage(cause),
				cause,
			};
		}
	}
	return { aborted: signal.aborted, runError, tail: buffer };
}
