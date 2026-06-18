/**
 * Chat conversation doc layout: the single owner of the doc-as-wire
 * transcript shape.
 *
 * A conversation is one Y.Doc holding a `Y.Array('messages')` of `Y.Map`s,
 * append-only, one map per message:
 *
 * ```txt
 * {
 *   id: string;            // assistant: equals the client-minted generationId
 *   role: 'user' | 'assistant';
 *   createdAt: number;
 *   content: Y.Text;       // token appends land here
 *   generationId?: string  // user: the assistant id this turn awaits (the work queue)
 *   finish?: ChatDocFinish // server, written at most once; absence = not terminal
 * }
 * ```
 *
 * The user turn carries its own `generationId`: the durable, client-minted id
 * that names the assistant answer it awaits and doubles as that answer's
 * message id. An unanswered user turn IS the work queue, so an actor that only
 * observes the doc (no HTTP kickoff body) reads the identity from the turn
 * itself.
 *
 * Single writer per map: the creating client for user messages, the server
 * generation actor for assistant messages. Both sides import this module so
 * the CRDT layout never forks; consumers see snapshots and writers, never
 * raw Y types.
 */

import type { ModelMessage } from '@tanstack/ai';
import * as Y from 'yjs';

/**
 * Terminal outcome of an assistant message, written at most once by the
 * generation actor. Absence means the message is not terminal: either still
 * streaming (recent updates) or an interrupted artifact (quiet past the
 * grace window).
 */
export type ChatDocFinish =
	| { kind: 'completed' }
	| { kind: 'cancelled' }
	| { kind: 'failed'; code: string; message: string };

/** Plain snapshot of one message, decoupled from the live Y types. */
export type ChatDocMessage = {
	id: string;
	role: 'user' | 'assistant';
	createdAt: number;
	text: string;
	/**
	 * User turns only: the assistant id this turn awaits, used by the actor as
	 * the idempotent assistant message id. Absent on assistant messages.
	 */
	generationId?: string;
	/**
	 * User turns only: a client-owned request to cancel the in-flight answer to
	 * this turn. The client writes it (single writer per field); the actor reads
	 * it back mid-answer and writes a `cancelled` finish. A retry that re-points
	 * the turn's `generationId` clears it, so the fresh generation is not born
	 * cancelled.
	 */
	cancelRequestedAt?: number;
	finish?: ChatDocFinish;
};

/**
 * A user turn that is ready to be answered: its `generationId` is present (so
 * the actor has the idempotent assistant id) and {@link findUnansweredTurn} has
 * confirmed no answer or active generation exists yet.
 */
export type AnswerableTurn = ChatDocMessage & { generationId: string };

/**
 * Unfinished assistant messages younger than this are presumed live. Older
 * ones are interrupted artifacts (worker eviction mid-generation) and should
 * not block or render as active.
 */
export const CHAT_DOC_ACTIVE_GENERATION_WINDOW_MS = 2 * 60 * 1000;

const MESSAGES_KEY = 'messages';

function messagesArray(doc: Y.Doc): Y.Array<Y.Map<unknown>> {
	return doc.getArray<Y.Map<unknown>>(MESSAGES_KEY);
}

/**
 * Append one user message. One transaction, one map; the caller mints the
 * id (any unique string) and the `generationId` (the assistant answer this
 * turn awaits). The caller never rewrites the id or content; only the
 * `generationId` may be re-pointed on retry via
 * {@link setLatestUserTurnGenerationId}, and only by this same client.
 */
export function appendUserMessage(
	doc: Y.Doc,
	{
		id,
		content,
		createdAt,
		generationId,
	}: { id: string; content: string; createdAt: number; generationId: string },
): void {
	doc.transact(() => {
		const map = new Y.Map<unknown>();
		const text = new Y.Text();
		map.set('id', id);
		map.set('role', 'user');
		map.set('createdAt', createdAt);
		map.set('content', text);
		map.set('generationId', generationId);
		text.insert(0, content);
		messagesArray(doc).push([map]);
	});
}

/**
 * Re-point the latest user turn's `generationId`, returning the id written or
 * `undefined` when no user turn has synced yet. Retry after a terminal answer
 * (failed or interrupted) mints a fresh id so the actor starts a new
 * generation instead of colliding with the answer already keyed to the old
 * id. The user turn belongs to the creating client, so re-pointing its
 * `generationId` stays single-writer.
 */
export function setLatestUserTurnGenerationId(
	doc: Y.Doc,
	generationId: string,
): string | undefined {
	const messages = messagesArray(doc);
	for (let index = messages.length - 1; index >= 0; index--) {
		const entry = messages.get(index);
		if (entry instanceof Y.Map && entry.get('role') === 'user') {
			doc.transact(() => {
				entry.set('generationId', generationId);
				// A retry is a fresh generation; drop any stale cancel request so it
				// is not born cancelled.
				entry.delete('cancelRequestedAt');
			});
			return generationId;
		}
	}
	return undefined;
}

/**
 * Stamp a client-owned cancel request on the latest user turn, returning the
 * timestamp written or `undefined` when no user turn has synced yet. The turn
 * belongs to the creating client, so writing `cancelRequestedAt` stays
 * single-writer; the actor reads it back mid-answer (its read-back departure
 * from the snapshot-once HTTP path) and writes a `cancelled` finish.
 */
export function requestLatestUserTurnCancel(
	doc: Y.Doc,
	cancelRequestedAt: number,
): number | undefined {
	const messages = messagesArray(doc);
	for (let index = messages.length - 1; index >= 0; index--) {
		const entry = messages.get(index);
		if (entry instanceof Y.Map && entry.get('role') === 'user') {
			doc.transact(() => entry.set('cancelRequestedAt', cancelRequestedAt));
			return cancelRequestedAt;
		}
	}
	return undefined;
}

/**
 * Append one assistant message with empty content and return its writer.
 *
 * The append itself is the "thinking" marker (an empty trailing assistant
 * map with a recent createdAt). The returned writer is the only handle that
 * may touch the map afterwards:
 *
 * - `appendText(text)`: one transaction per call; the flush policy upstream
 *   decides how often to call it.
 * - `finish(finish, { text? })`: the final transaction, appending any
 *   remaining text and writing the terminal `finish` key. At most one write
 *   sticks; later calls are no-ops.
 */
export function appendAssistantMessage(
	doc: Y.Doc,
	{ id, createdAt }: { id: string; createdAt: number },
) {
	const map = new Y.Map<unknown>();
	const content = new Y.Text();
	doc.transact(() => {
		map.set('id', id);
		map.set('role', 'assistant');
		map.set('createdAt', createdAt);
		map.set('content', content);
		messagesArray(doc).push([map]);
	});

	return {
		/** Append streamed text to the assistant message content. */
		appendText(text: string): void {
			if (!text) return;
			doc.transact(() => {
				content.insert(content.length, text);
			});
		},
		/** Append any final text and write the terminal outcome once. */
		finish(finish: ChatDocFinish, { text = '' }: { text?: string } = {}): void {
			if (map.get('finish') !== undefined) return;
			doc.transact(() => {
				if (text) content.insert(content.length, text);
				map.set('finish', finish);
			});
		},
	};
}

/**
 * Snapshot every message in transcript order. Entries that do not match the
 * layout (foreign maps, missing keys) are skipped rather than thrown on:
 * the doc syncs from untrusted peers and the readers (UI render, prompt
 * snapshot) both prefer a hole over a crash.
 */
export function readChatDocMessages(doc: Y.Doc): ChatDocMessage[] {
	const messages: ChatDocMessage[] = [];
	for (const entry of messagesArray(doc)) {
		if (!(entry instanceof Y.Map)) continue;
		const id = entry.get('id');
		const role = entry.get('role');
		const createdAt = entry.get('createdAt');
		const content = entry.get('content');
		if (typeof id !== 'string') continue;
		if (role !== 'user' && role !== 'assistant') continue;
		if (typeof createdAt !== 'number') continue;
		if (!(content instanceof Y.Text)) continue;
		const generationId = entry.get('generationId');
		const cancelRequestedAt = entry.get('cancelRequestedAt');
		const finish = entry.get('finish') as ChatDocFinish | undefined;
		messages.push({
			id,
			role,
			createdAt,
			text: content.toString(),
			...(typeof generationId === 'string' && { generationId }),
			...(typeof cancelRequestedAt === 'number' && { cancelRequestedAt }),
			...(finish !== undefined && { finish }),
		});
	}
	return messages;
}

/**
 * The latest user message in transcript order, or `undefined` when none has
 * synced yet. The actor answers this turn, taking its `generationId` as the
 * idempotent assistant message id. Pure over a snapshot; never touches the doc.
 */
export function findLatestUserTurn(
	messages: readonly ChatDocMessage[],
): ChatDocMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === 'user') return message;
	}
	return undefined;
}

/**
 * Find the latest recent unfinished assistant message that should still block
 * another generation. Server and client both use this predicate so they agree
 * on the difference between "still live" and "interrupted artifact".
 */
export function findActiveChatDocGeneration(
	messages: readonly ChatDocMessage[],
	now: number,
): ChatDocMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (
			message?.role === 'assistant' &&
			message.finish === undefined &&
			now - message.createdAt < CHAT_DOC_ACTIVE_GENERATION_WINDOW_MS
		) {
			return message;
		}
	}
	return undefined;
}

/**
 * The latest user turn that is ready to be answered, or `undefined` when there
 * is nothing to answer yet. This is the single answer predicate the observing
 * actor reconciles: a turn qualifies only when it carries a `generationId`, no
 * message is already keyed to that id (the existence-based claim), and no recent
 * unfinished assistant turn is still streaming.
 *
 * Pure over a snapshot; never touches the doc. It is deliberately turn-or-
 * nothing: the HTTP generation path keeps its own 400-vs-409 taxonomy for its
 * response, but the actor only needs "answer this turn, or nothing".
 */
export function findUnansweredTurn(
	messages: readonly ChatDocMessage[],
	now: number,
): AnswerableTurn | undefined {
	const turn = findLatestUserTurn(messages);
	if (turn?.generationId === undefined) return undefined;
	// Existence IS the claim: a message keyed to this id means the turn is
	// already claimed or answered.
	if (messages.some((message) => message.id === turn.generationId)) {
		return undefined;
	}
	// A recent unfinished assistant turn is still live; let it finish first.
	if (findActiveChatDocGeneration(messages, now)) return undefined;
	return turn as AnswerableTurn;
}

/**
 * Snapshot the transcript as a provider prompt. Empty messages (an interrupted
 * assistant turn that never received a token) carry no signal and are dropped.
 * The transcript module owns this conversion because it owns the message shape;
 * both the actor and the HTTP generation path freeze their prompt this way.
 */
export function chatDocToPrompt(
	messages: readonly ChatDocMessage[],
): ModelMessage[] {
	return messages
		.filter((message) => message.text.length > 0)
		.map((message) => ({ role: message.role, content: message.text }));
}

/**
 * Observe every change to the transcript (new messages, token appends,
 * finish writes). The callback fires once per transaction; re-read with
 * {@link readChatDocMessages}. Returns the unobserve function.
 */
export function observeChatDocMessages(
	doc: Y.Doc,
	callback: () => void,
): () => void {
	const target = messagesArray(doc);
	const observer = () => callback();
	target.observeDeep(observer);
	return () => target.unobserveDeep(observer);
}

/**
 * `attachChatTranscript(ydoc)`: the conversation layout as a handle (shape +
 * client writer policy), declared as a child-doc layout via
 * `table.docs({ messages: attachChatTranscript })`.
 *
 * This is the client surface of the transcript: read the messages, observe
 * changes, and append a user message (the one write a browser client owns). The
 * assistant-message writer is the server generation actor, which imports
 * {@link appendAssistantMessage} directly; that writer policy is exactly why
 * this handle exposes `appendUser` and not an assistant writer.
 *
 * The free functions above remain the implementation and the server's entry
 * point; this handle is the boundary-respecting view a UI binds to (no raw
 * `ydoc` reach). `findActiveChatDocGeneration` stays a free function: it is pure
 * over a message snapshot and never touches the doc.
 */
export function attachChatTranscript(doc: Y.Doc) {
	return {
		/** Snapshot every message in transcript order. */
		read(): ChatDocMessage[] {
			return readChatDocMessages(doc);
		},
		/**
		 * Observe transcript changes (new messages, token appends, finish writes).
		 * Fires once per transaction; re-read with {@link read}. Returns unobserve.
		 */
		observe(callback: () => void): () => void {
			return observeChatDocMessages(doc, callback);
		},
		/**
		 * Append one user message. Single writer: the creating client mints the id
		 * and the `generationId` (the assistant answer this turn awaits) and never
		 * rewrites the id or content.
		 */
		appendUser(message: {
			id: string;
			content: string;
			createdAt: number;
			generationId: string;
		}): void {
			appendUserMessage(doc, message);
		},
		/**
		 * Re-point the latest user turn's `generationId` for a retry. Returns the
		 * id written, or `undefined` when no user turn has synced yet. See
		 * {@link setLatestUserTurnGenerationId}.
		 */
		remintGeneration(generationId: string): string | undefined {
			return setLatestUserTurnGenerationId(doc, generationId);
		},
		/**
		 * Request cancellation of the latest user turn's in-flight answer. The
		 * client owns this field; the actor reads it back mid-answer and writes a
		 * `cancelled` finish. Returns the timestamp written, or `undefined` when no
		 * user turn has synced yet. See {@link requestLatestUserTurnCancel}.
		 */
		requestCancel(cancelRequestedAt: number): number | undefined {
			return requestLatestUserTurnCancel(doc, cancelRequestedAt);
		},
	};
}
