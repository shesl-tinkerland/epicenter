/**
 * The doc -> render-state projection: one pure function every render-from-doc
 * client uses to turn a transcript snapshot into the liveness and status a chat
 * UI paints.
 *
 * Every answerer writes the same conversation doc and every client renders it
 * (ADR-0033), so every client independently re-derived the same questions from a
 * message snapshot plus a clock: is a turn live, is it still thinking, did it
 * stream text, was it interrupted, did it fail. That derivation is pure and was
 * copied across apps; it belongs here once, beside {@link findActiveChatDocGeneration},
 * so every renderer agrees on "live vs interrupted" exactly as server and client
 * already agree on "active generation."
 *
 * The one signal a client owns that the doc cannot yet show is a trigger in
 * flight before the answerer has claimed: the cloud kickoff's HTTP request is
 * open but the server has not written the assistant message, so the doc shows no
 * active generation. The client passes that as {@link ChatRenderInput.externallyGenerating};
 * an in-process or ambient answerer claims synchronously, so it passes `false`
 * and the doc alone drives liveness.
 *
 * @module
 */

import type { ChatDocFinish, ChatDocMessage } from './chat-doc.js';
import { findActiveChatDocGeneration } from './chat-doc.js';

/**
 * How long after the last doc update an unfinished trailing assistant message
 * still counts as live. Past this it reads as interrupted; a finish write (the
 * normal terminal) flips liveness off well before it matters. Shared so every
 * client uses the same grace window.
 */
export const CHAT_STREAM_GRACE_MS = 3000;

/** A failed terminal outcome, the only finish a render surfaces as an error. */
export type ChatFailure = Extract<ChatDocFinish, { kind: 'failed' }>;

/** The status union a message list paints, mirroring TanStack AI's chat status. */
export type ChatRenderStatus = 'ready' | 'submitted' | 'streaming' | 'error';

export type ChatRenderInput = {
	/** Reactive clock; advances liveness past the grace window without doc events. */
	now: number;
	/** Wall-clock of the last observed doc change (token append, finish write). */
	lastChangeAt: number;
	/**
	 * A trigger in flight that the doc does not yet reflect (the cloud kickoff's
	 * open HTTP request before the server claims). An in-process / ambient answerer
	 * claims synchronously and passes `false`. Default `false`.
	 */
	externallyGenerating?: boolean;
	/** Override the grace window; defaults to {@link CHAT_STREAM_GRACE_MS}. */
	graceMs?: number;
};

/**
 * The rendered view of a conversation: the messages worth painting plus the
 * derived liveness/status a chat UI binds to. Pure over a snapshot.
 */
export type ChatRenderState = {
	/**
	 * Messages with a renderable body: every user turn, and every assistant turn
	 * that has streamed at least one character. The empty assistant placeholder a
	 * claim appends before its first token is dropped; {@link ChatRenderState.isThinking}
	 * stands in for it (the typing bubble).
	 */
	visibleMessages: ChatDocMessage[];
	/** The last message in transcript order, renderable or not. */
	trailing: ChatDocMessage | undefined;
	/** The recent unfinished assistant turn still blocking another generation. */
	activeGeneration: ChatDocMessage | undefined;
	/** A turn is being produced (a live doc generation, or an external trigger). */
	isGenerating: boolean;
	/** Generating but no assistant text yet: the typing/thinking state. */
	isThinking: boolean;
	/** A trailing assistant turn with no finish that is no longer live. */
	isInterrupted: boolean;
	/** The trailing turn's failed finish, or `undefined`. */
	failure: ChatFailure | undefined;
	/** The single status a message list reads. */
	status: ChatRenderStatus;
};

/**
 * Project a transcript snapshot into its render state. The caller observes the
 * doc, keeps `now` on a ticker, and tracks `lastChangeAt`; this owns the rest.
 */
export function chatRenderState(
	messages: readonly ChatDocMessage[],
	{
		now,
		lastChangeAt,
		externallyGenerating = false,
		graceMs = CHAT_STREAM_GRACE_MS,
	}: ChatRenderInput,
): ChatRenderState {
	const trailing = messages.at(-1);
	const activeGeneration = findActiveChatDocGeneration(messages, now);

	// A live generation streams into the doc, so its updates are recent; past the
	// grace window with no finish it has stalled (an interrupted artifact).
	const isStreamingLive =
		activeGeneration !== undefined && now - lastChangeAt < graceMs;
	const isGenerating = externallyGenerating || isStreamingLive;

	const isThinking =
		isGenerating &&
		(activeGeneration?.text.length === 0 ||
			(activeGeneration === undefined && trailing?.role !== 'assistant'));

	const isInterrupted =
		trailing?.role === 'assistant' &&
		trailing.finish === undefined &&
		!isGenerating;

	const failure =
		trailing?.finish?.kind === 'failed' ? trailing.finish : undefined;

	const status: ChatRenderStatus = failure
		? 'error'
		: !isGenerating
			? 'ready'
			: (activeGeneration?.text.length ?? 0) > 0
				? 'streaming'
				: 'submitted';

	const visibleMessages = messages.filter(
		(message) => message.role === 'user' || message.text.length > 0,
	);

	return {
		visibleMessages,
		trailing,
		activeGeneration,
		isGenerating,
		isThinking,
		isInterrupted,
		failure,
		status,
	};
}
