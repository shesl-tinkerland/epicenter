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
 *   parts: Y.Array<Y.Map>; // ordered body parts; streamed text appends into a per-part Y.Text
 *   generationId?: string  // user: the assistant id this turn awaits (the work queue)
 *   finish?: ChatDocFinish // server, written at most once; absence = not terminal
 * }
 * ```
 *
 * The body is an ordered parts array (ADR-0036), not a single text run. Each
 * part is a typed `Y.Map` keyed by `type`; a text part streams tokens into its
 * own `Y.Text`. A text-only answer (vocab) is one text part, behaviorally
 * identical to the old single `content`; a tool-using answer (Local Books)
 * interleaves `tool-call` and `tool-result` parts. Phase 1 writes only text
 * parts; the union is defined in full so the reader and prompt walk are already
 * parts-shaped when tool parts arrive.
 *
 * The user turn carries its own `generationId`: the durable, client-minted id
 * that names the assistant answer it awaits and doubles as that answer's
 * message id. An unanswered user turn IS the work queue, so a worker that only
 * observes the doc (no HTTP kickoff body) reads the identity from the turn
 * itself.
 *
 * Single writer per map: the creating client for user messages, the server
 * generation worker for assistant messages. Both sides import this module so
 * the CRDT layout never forks; consumers see snapshots and writers, never
 * raw Y types.
 */

import type { ModelMessage } from '@tanstack/ai';
import type { JsonValue } from 'wellcrafted/json';
import * as Y from 'yjs';

/**
 * Terminal outcome of an assistant message, written at most once by the
 * generation worker. Absence means the message is not terminal: either still
 * streaming (recent updates) or an interrupted artifact (quiet past the
 * grace window).
 */
export type ChatDocFinish =
	| { kind: 'completed' }
	| { kind: 'cancelled' }
	| { kind: 'failed'; code: string; message: string };

/**
 * Lifecycle of a tool-call part, mirroring TanStack AI's `ToolCallState`. A
 * call streams its `arguments`, freezes a parsed `input` at `input-complete`,
 * then completes or errors. Defined for the full body union; only written once
 * the agentic tool loop lands (Phase 3).
 */
export type ChatDocToolCallState =
	| 'awaiting-input'
	| 'input-streaming'
	| 'input-complete'
	| 'complete'
	| 'error';

/** Lifecycle of a tool-result part, mirroring TanStack AI's `ToolResultState`. */
export type ChatDocToolResultState = 'streaming' | 'complete' | 'error';

const TOOL_CALL_STATES: ReadonlySet<string> = new Set<ChatDocToolCallState>([
	'awaiting-input',
	'input-streaming',
	'input-complete',
	'complete',
	'error',
]);

const TOOL_RESULT_STATES: ReadonlySet<string> = new Set<ChatDocToolResultState>(
	['streaming', 'complete', 'error'],
);

/** Streamed prose. The live form is a `Y.Text`; the snapshot is a plain string. */
export type ChatDocTextPart = { type: 'text'; content: string };

/**
 * A tool the agent ran (the recipe). `arguments` is partial JSON while
 * streaming; `input` is the parsed value, frozen once at `input-complete`. The
 * recipe lets a reader re-run the tool when a capped result dropped detail.
 */
export type ChatDocToolCallPart = {
	type: 'tool-call';
	id: string;
	name: string;
	arguments: string;
	input?: JsonValue;
	state: ChatDocToolCallState;
};

/**
 * The output a tool produced, stored capped: `content` is truncated to a fixed
 * character budget with a `[truncated: N of M]` marker so the transcript stays a
 * self-contained synced artifact without unbounded growth.
 */
export type ChatDocToolResultPart = {
	type: 'tool-result';
	toolCallId: string;
	content: string;
	state: ChatDocToolResultState;
};

/**
 * One body part, snapshotted from its `Y.Map` and decoupled from the live Y
 * types. The persisted subset of TanStack AI's `MessagePart` union: text,
 * tool-call (the recipe), and a capped tool-result. `thinking` is dropped.
 */
export type ChatDocPart =
	| ChatDocTextPart
	| ChatDocToolCallPart
	| ChatDocToolResultPart;

/** Plain snapshot of one message, decoupled from the live Y types. */
export type ChatDocMessage = {
	id: string;
	role: 'user' | 'assistant';
	createdAt: number;
	/** The ordered body parts, snapshotted in transcript order. */
	parts: ChatDocPart[];
	/**
	 * Derived: the concatenation of every text part's content. Kept as the
	 * back-compat seam the prompt filter and the UI render predicate read, so a
	 * text-only consumer never walks `parts` to ask "is this turn empty".
	 */
	text: string;
	/**
	 * User turns only: the assistant id this turn awaits, used by the worker as
	 * the idempotent assistant message id. Absent on assistant messages.
	 */
	generationId?: string;
	/**
	 * User turns only: a client-owned request to cancel the in-flight answer to
	 * this turn. The client writes it (single writer per field); the worker reads
	 * it back mid-answer and writes a `cancelled` finish. A retry that re-points
	 * the turn's `generationId` clears it, so the fresh generation is not born
	 * cancelled.
	 */
	cancelRequestedAt?: number;
	finish?: ChatDocFinish;
};

/**
 * A user turn that is ready to be answered: its `generationId` is present (so
 * the worker has the idempotent assistant id) and {@link findUnansweredTurn} has
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
const PARTS_KEY = 'parts';

function messagesArray(doc: Y.Doc): Y.Array<Y.Map<unknown>> {
	return doc.getArray<Y.Map<unknown>>(MESSAGES_KEY);
}

/**
 * Append `text` into the parts array's trailing text part, creating one if the
 * last part is not text (the empty array, or a non-text part ending the body).
 * The streamed-text vehicle is the part's own `Y.Text`, suffix-appended so one
 * token is one merged insert. Caller wraps this in a transaction.
 */
function appendIntoTrailingTextPart(
	parts: Y.Array<Y.Map<unknown>>,
	text: string,
): void {
	const last = parts.get(parts.length - 1);
	const trailingText =
		last instanceof Y.Map &&
		last.get('type') === 'text' &&
		last.get('content') instanceof Y.Text
			? (last.get('content') as Y.Text)
			: undefined;
	if (trailingText) {
		trailingText.insert(trailingText.length, text);
		return;
	}
	const part = new Y.Map<unknown>();
	const content = new Y.Text();
	part.set('type', 'text');
	part.set('content', content);
	// Integrate the part before writing its text so the insert lands on an
	// attached type (Yjs warns on reads/writes against a detached one).
	parts.push([part]);
	content.insert(0, text);
}

/**
 * Append one user message. One transaction, one map; the caller mints the
 * id (any unique string) and the `generationId` (the assistant answer this
 * turn awaits). A user turn is one text part. The caller never rewrites the id
 * or body; only the `generationId` may be re-pointed on retry via
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
		const parts = new Y.Array<Y.Map<unknown>>();
		map.set('id', id);
		map.set('role', 'user');
		map.set('createdAt', createdAt);
		map.set(PARTS_KEY, parts);
		map.set('generationId', generationId);
		// Integrate the message before filling its body so the text part lands on
		// an attached array (the assistant writer does the same: append, then stream).
		messagesArray(doc).push([map]);
		appendIntoTrailingTextPart(parts, content);
	});
}

/**
 * Re-point the latest user turn's `generationId`, returning the id written or
 * `undefined` when no user turn has synced yet. Retry after a terminal answer
 * (failed or interrupted) mints a fresh id so the worker starts a new
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
 * single-writer; the worker reads it back mid-answer (its read-back departure
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
 * Append one assistant message with an empty parts array and return its writer.
 *
 * The append itself is the "thinking" marker (an empty trailing assistant
 * map with a recent createdAt). The returned writer is the only handle that
 * may touch the map afterwards:
 *
 * - `appendText(text)`: one transaction per call; ensures a trailing text part
 *   and suffix-appends into its `Y.Text`. The flush policy upstream decides how
 *   often to call it.
 * - `finish(finish, { text? })`: the final transaction, appending any
 *   remaining text and writing the terminal `finish` key. At most one write
 *   sticks; later calls are no-ops.
 */
export function appendAssistantMessage(
	doc: Y.Doc,
	{ id, createdAt }: { id: string; createdAt: number },
) {
	const map = new Y.Map<unknown>();
	const parts = new Y.Array<Y.Map<unknown>>();
	doc.transact(() => {
		map.set('id', id);
		map.set('role', 'assistant');
		map.set('createdAt', createdAt);
		map.set(PARTS_KEY, parts);
		messagesArray(doc).push([map]);
	});

	return {
		/** Append streamed text into the assistant message's trailing text part. */
		appendText(text: string): void {
			if (!text) return;
			doc.transact(() => {
				appendIntoTrailingTextPart(parts, text);
			});
		},
		/** Append any final text and write the terminal outcome once. */
		finish(finish: ChatDocFinish, { text = '' }: { text?: string } = {}): void {
			if (map.get('finish') !== undefined) return;
			doc.transact(() => {
				if (text) appendIntoTrailingTextPart(parts, text);
				map.set('finish', finish);
			});
		},
	};
}

/**
 * Snapshot one part `Y.Map`, or `undefined` when it does not match the layout.
 * The doc syncs from untrusted peers, so a foreign or malformed part is a hole,
 * not a crash (the per-part version of the per-message skip in
 * {@link readChatDocMessages}). An unknown `type` is dropped so new part kinds
 * stay additive.
 */
function readPart(part: Y.Map<unknown>): ChatDocPart | undefined {
	const type = part.get('type');
	if (type === 'text') {
		const content = part.get('content');
		if (!(content instanceof Y.Text)) return undefined;
		return { type: 'text', content: content.toString() };
	}
	if (type === 'tool-call') {
		const id = part.get('id');
		const name = part.get('name');
		const args = part.get('arguments');
		const state = part.get('state');
		if (typeof id !== 'string') return undefined;
		if (typeof name !== 'string') return undefined;
		if (!(args instanceof Y.Text)) return undefined;
		if (typeof state !== 'string' || !TOOL_CALL_STATES.has(state)) {
			return undefined;
		}
		const input = part.get('input');
		return {
			type: 'tool-call',
			id,
			name,
			arguments: args.toString(),
			state: state as ChatDocToolCallState,
			...(input !== undefined && { input: input as JsonValue }),
		};
	}
	if (type === 'tool-result') {
		const toolCallId = part.get('toolCallId');
		const content = part.get('content');
		const state = part.get('state');
		if (typeof toolCallId !== 'string') return undefined;
		if (typeof content !== 'string') return undefined;
		if (typeof state !== 'string' || !TOOL_RESULT_STATES.has(state)) {
			return undefined;
		}
		return {
			type: 'tool-result',
			toolCallId,
			content,
			state: state as ChatDocToolResultState,
		};
	}
	return undefined;
}

/** Snapshot every part of one message's body in order, skipping malformed parts. */
function readParts(parts: Y.Array<unknown>): ChatDocPart[] {
	const result: ChatDocPart[] = [];
	for (const part of parts) {
		if (!(part instanceof Y.Map)) continue;
		const snapshot = readPart(part);
		if (snapshot !== undefined) result.push(snapshot);
	}
	return result;
}

/**
 * Snapshot every message in transcript order. Entries that do not match the
 * layout (foreign maps, missing keys) are skipped rather than thrown on:
 * the doc syncs from untrusted peers and the readers (UI render, prompt
 * snapshot) both prefer a hole over a crash.
 *
 * The body is read from `parts` only. There is no legacy `content` branch: a
 * pre-parts message reads as no parts (an empty body) and contributes no text,
 * the clean break that discards old transcripts without a migration reader.
 */
export function readChatDocMessages(doc: Y.Doc): ChatDocMessage[] {
	const messages: ChatDocMessage[] = [];
	for (const entry of messagesArray(doc)) {
		if (!(entry instanceof Y.Map)) continue;
		const id = entry.get('id');
		const role = entry.get('role');
		const createdAt = entry.get('createdAt');
		const parts = entry.get(PARTS_KEY);
		if (typeof id !== 'string') continue;
		if (role !== 'user' && role !== 'assistant') continue;
		if (typeof createdAt !== 'number') continue;
		if (!(parts instanceof Y.Array)) continue;
		const snapshot = readParts(parts);
		const text = snapshot
			.filter((part): part is ChatDocTextPart => part.type === 'text')
			.map((part) => part.content)
			.join('');
		const generationId = entry.get('generationId');
		const cancelRequestedAt = entry.get('cancelRequestedAt');
		const finish = entry.get('finish') as ChatDocFinish | undefined;
		messages.push({
			id,
			role,
			createdAt,
			parts: snapshot,
			text,
			...(typeof generationId === 'string' && { generationId }),
			...(typeof cancelRequestedAt === 'number' && { cancelRequestedAt }),
			...(finish !== undefined && { finish }),
		});
	}
	return messages;
}

/**
 * The latest user message in transcript order, or `undefined` when none has
 * synced yet. The worker answers this turn, taking its `generationId` as the
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
 * worker reconciles: a turn qualifies only when it carries a `generationId`, no
 * message is already keyed to that id (the existence-based claim), and no recent
 * unfinished assistant turn is still streaming.
 *
 * Pure over a snapshot; never touches the doc. It is deliberately turn-or-
 * nothing: the HTTP generation path keeps its own 400-vs-409 taxonomy for its
 * response, but the worker only needs "answer this turn, or nothing".
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
 * Snapshot the transcript as a provider prompt. The body is walked natively:
 * a message's text parts concatenate into its `content`. Empty messages (an
 * interrupted assistant turn that never received a token) carry no signal and
 * are dropped. Tool-call and tool-result parts become their own ModelMessages
 * once the agentic loop lands (Phase 3); a text-only transcript produces the
 * same `{ role, content }` sequence the single-content body did.
 *
 * The transcript module owns this conversion because it owns the body shape;
 * both the worker and the HTTP generation path freeze their prompt this way.
 */
export function chatDocToPrompt(
	messages: readonly ChatDocMessage[],
): ModelMessage[] {
	const prompt: ModelMessage[] = [];
	for (const message of messages) {
		const content = message.parts
			.filter((part): part is ChatDocTextPart => part.type === 'text')
			.map((part) => part.content)
			.join('');
		if (content.length === 0) continue;
		prompt.push({ role: message.role, content });
	}
	return prompt;
}

/**
 * Observe every change to the transcript (new messages, token appends,
 * finish writes). The callback fires once per transaction; re-read with
 * {@link readChatDocMessages}. `observeDeep` reaches the nested parts and their
 * `Y.Text`, so a token append into a part fires it. Returns the unobserve function.
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
 * assistant-message writer is the server generation worker, which imports
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
		 * rewrites the id or body.
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
		 * client owns this field; the worker reads it back mid-answer and writes a
		 * `cancelled` finish. Returns the timestamp written, or `undefined` when no
		 * user turn has synced yet. See {@link requestLatestUserTurnCancel}.
		 */
		requestCancel(cancelRequestedAt: number): number | undefined {
			return requestLatestUserTurnCancel(doc, cancelRequestedAt);
		},
	};
}
