/**
 * `attachChatConversation(doc)`: the conversation controller as one handle.
 *
 * `attachChatTranscript` is the raw transcript (read/observe plus the durable
 * writes a turn needs). Every chat UI then re-wrapped it the same way: open the
 * doc, run an in-process answerer over it (ADR-0033's `in-process` trigger),
 * tick a clock, project the snapshot through {@link chatRenderState}, and expose
 * send/stop/retry. This folds that controller onto the handle so apps stop
 * reimplementing it: `tables.<t>.docs.<field>.open(rowId)` returns a handle that
 * already answers, sends, retries, cancels, and reports its render status.
 *
 * The handle owns the answerer's lifecycle (one answerer per handle; aborted on
 * teardown) and the liveness clock input (`lastChangeAt`, bumped from the doc's
 * own observer). The caller still owns the *policy*: whether to answer at all is
 * a per-conversation decision (a daemon-bound conversation is answered over sync,
 * so the browser stays out), so `answer(startStream)` is a method the app calls
 * only when the browser is the answerer, never wired at layout time.
 *
 * The reactive layer (the `now` ticker, the rune-tracked re-read) lives in
 * `@epicenter/svelte`'s `bindConversation`, which drives this handle; runes
 * cannot live in this package.
 *
 * @module
 */

import type * as Y from 'yjs';
import { generateId } from '../shared/id.js';
import type { ChatStream } from './chat-answer.js';
import { attachChatBrowserAnswerer } from './chat-browser-answerer.js';
import {
	attachChatTranscript,
	type ChatDocMessage,
	findActiveChatDocGeneration,
} from './chat-doc.js';
import { type ChatRenderState, chatRenderState } from './chat-render-state.js';

/**
 * Compose the conversation controller over a transcript child doc. Adds the
 * answerer lifecycle, the send/retry/stop sugar, and a `status(now)` projection
 * onto the {@link attachChatTranscript} handle.
 *
 * Registers a listener at call time (the `attach*` contract): a self-observer
 * that tracks `lastChangeAt` for liveness, torn down with any in-flight answerer
 * when the doc is destroyed (the `.open()` handle's dispose calls `doc.destroy()`).
 */
export function attachChatConversation(doc: Y.Doc) {
	const transcript = attachChatTranscript(doc);

	// The liveness clock input: when the doc last changed. Seed it so a
	// conversation reopened mid-answer reads as live (not instantly interrupted)
	// until the next doc event refreshes it; a settled conversation starts at 0.
	let lastChangeAt = findActiveChatDocGeneration(transcript.read(), Date.now())
		? Date.now()
		: 0;
	const unobserve = transcript.observe(() => {
		lastChangeAt = Date.now();
	});

	// One answerer per handle. The app may re-`answer()` (e.g. a rebind), so a
	// prior answerer is stopped first; teardown aborts whatever is in flight.
	let stopAnswerer: (() => void) | undefined;
	doc.once('destroy', () => {
		unobserve();
		stopAnswerer?.();
	});

	return {
		...transcript,

		/**
		 * Run the in-process answerer over this conversation, sourcing tokens from
		 * `startStream` (a local model, the user's BYOK provider, or the Epicenter
		 * provider over the metered endpoint). Returns a stop function; the handle
		 * also stops it on teardown. Call this only when the browser is the
		 * answerer (a daemon-bound conversation is answered over sync instead).
		 */
		answer(startStream: ChatStream): () => void {
			stopAnswerer?.();
			const stop = attachChatBrowserAnswerer({ doc, startStream });
			stopAnswerer = stop;
			return () => {
				stop();
				if (stopAnswerer === stop) stopAnswerer = undefined;
			};
		},

		/**
		 * Send one user turn: mint the message id and the `generationId` the answer
		 * awaits, then append it. The in-process answerer (or a bound daemon)
		 * observes the write and claims the turn. No-op on empty input.
		 */
		send(content: string): void {
			const text = content.trim();
			if (!text) return;
			transcript.appendUser({
				id: generateId(),
				content: text,
				createdAt: Date.now(),
				generationId: generateId(),
			});
		},

		/**
		 * Retry the latest turn: re-mint its `generationId` so the answerer starts a
		 * fresh generation instead of finding the terminal (failed or interrupted)
		 * answer already claimed.
		 */
		retry(): void {
			transcript.remintGeneration(generateId());
		},

		/**
		 * Stop the in-flight answer with the client-owned durable cancel: the
		 * answerer reads `cancelRequestedAt` back mid-stream and writes a cancelled
		 * finish, so it works from any device.
		 */
		stop(): void {
			transcript.requestCancel(Date.now());
		},

		/**
		 * Project the current transcript into the liveness and status a chat UI
		 * binds to, given the caller's clock. Pure over the snapshot plus the
		 * handle's own `lastChangeAt`; the reactive `now` is supplied by the shim.
		 */
		status(now: number): ChatRenderState {
			return chatRenderState(transcript.read(), { now, lastChangeAt });
		},
	};
}

/** The conversation handle {@link attachChatConversation} returns. */
export type ChatConversationHandle = ReturnType<typeof attachChatConversation>;
export type { ChatDocMessage };
