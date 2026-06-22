/**
 * Extension-local chat store (ADR-0051).
 *
 * Chat is fully device-local. One IndexedDB database, two object stores:
 *
 * - `messages`: one row per finished {@link AgentMessage}, keyed
 *   `${conversationId} ${messageId}`, so a conversation's transcript is a
 *   key-range scan and the client agent loop's by-id writes land as individual
 *   rows.
 * - `settings`: conversationId -> {@link ModelChoice}, the per-conversation
 *   model pick, written by the conversation handles.
 *
 * The store backs the one client agent loop (ADR-0047) through a device-local
 * {@link attachConversationStore}: the loop reads and writes finished messages
 * by id exactly as it does over a synced Yjs child doc, but here the records
 * live in IndexedDB and never enter a CRDT. ADR-0051: the loop's store seam, not
 * a second loop, chooses persistence, so a device-scoped transcript pays no
 * tombstone or sync cost while still running the one loop.
 *
 * The conversation list is derived from this store: a conversation exists once
 * its first message lands (drafts live in memory only), its title and timestamps
 * derive from the messages themselves, and deleting it removes both rows.
 * Nothing about chat lives in the synced workspace: transcripts are
 * single-writer, device-scoped logs, and a local-model path means a turn may
 * never touch the server, so CRDT storage would pay tombstone and sync costs for
 * no conflict-resolution benefit.
 */

import { generateId, type Id, type KvStoreHandle } from '@epicenter/workspace';
import type { AgentMessage } from '@epicenter/workspace/agent';
import type { Brand } from 'wellcrafted/brand';

// ── Conversation identity ──────────────────────────────────────────────
// The brand lives here because the chat store owns the key space; chat is
// not a workspace concern.

/** Branded conversation ID: nanoid generated when a conversation is created. */
export type ConversationId = Id & Brand<'ConversationId'>;

/** Generate a unique {@link ConversationId} for a new conversation. */
export const generateConversationId = (): ConversationId =>
	generateId() as ConversationId;

/**
 * Syntactic sugar for `value as ConversationId`. The constrained `string`
 * parameter is what earns it over a raw `as` cast (callers can't widen to
 * `unknown`). The only place in the codebase where `as ConversationId`
 * should appear.
 */
export const asConversationId = (value: string): ConversationId =>
	value as ConversationId;

/**
 * The per-conversation model pick. Provider is derived from the model by the
 * catalog, so it is not stored; rows written by older builds carry an extra
 * `provider` field that is simply ignored on read.
 */
export type ModelChoice = { model: string };

// ── IndexedDB plumbing ─────────────────────────────────────────────────

const DB_NAME = 'tab-manager-chat';
// Version 3 keys each message row by a space separator (ADR-0051). Versions 1
// and 2 are dropped on upgrade, not migrated: v1 stored a whole `UIMessage[]`
// per conversation under the TanStack `createChat` loop, and v2 separated keys
// with a NUL byte that made this source a binary blob to git. A device-local
// scratch history carries no durable contract across these swaps.
const DB_VERSION = 3;
const MESSAGES_STORE = 'messages';
const SETTINGS_STORE = 'settings';

// A `messages` key is `${conversationId} ${messageId}`. A space sorts below
// every nanoid character (URL-safe alphabet) and never appears inside an id, so
// the range below covers exactly one conversation's rows; `￿` is the upper
// sentinel past any message id.
const KEY_SEP = ' ';

const messageKey = (
	conversationId: ConversationId,
	messageId: string,
): string => `${conversationId}${KEY_SEP}${messageId}`;

/** The key range covering every message of one conversation. */
const conversationRange = (conversationId: ConversationId): IDBKeyRange =>
	IDBKeyRange.bound(
		`${conversationId}${KEY_SEP}`,
		`${conversationId}${KEY_SEP}￿`,
	);

const conversationIdOf = (key: string): ConversationId =>
	asConversationId(key.slice(0, key.indexOf(KEY_SEP)));

const messageIdOf = (key: string): string =>
	key.slice(key.indexOf(KEY_SEP) + 1);

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

let dbPromise: Promise<IDBDatabase> | undefined;

function openDb(): Promise<IDBDatabase> {
	dbPromise ??= (() => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			// Drop the v1 per-conversation `UIMessage[]` store; recreate it as the
			// per-message store. Settings carry the same key space, so it is kept.
			if (db.objectStoreNames.contains(MESSAGES_STORE)) {
				db.deleteObjectStore(MESSAGES_STORE);
			}
			db.createObjectStore(MESSAGES_STORE);
			if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
				db.createObjectStore(SETTINGS_STORE);
			}
		};
		return requestToPromise(request);
	})();
	return dbPromise;
}

function store(
	name: typeof MESSAGES_STORE | typeof SETTINGS_STORE,
	mode: IDBTransactionMode,
): Promise<IDBObjectStore> {
	return openDb().then((db) => db.transaction(name, mode).objectStore(name));
}

// Every write to the `messages` store funnels through one queue, so writes commit
// in the order they were issued across all conversations: a per-message `set` or
// `delete` and a whole-conversation wipe (`clearConversation`) can never reorder
// into a different commit sequence. Reads are unqueued; the cache's
// hydrate-doesn't-clobber rule (below) covers read/write interleaving.
let messageWrites: Promise<unknown> = Promise.resolve();

/**
 * Queue a write against the `messages` store. The returned promise resolves once
 * this write has committed (after every write queued before it) and never
 * rejects: a failure is logged so the queue keeps draining.
 */
function enqueueMessageWrite(
	write: (messages: IDBObjectStore) => IDBRequest,
): Promise<unknown> {
	messageWrites = messageWrites
		.then(() => store(MESSAGES_STORE, 'readwrite'))
		.then((messages) => requestToPromise(write(messages)))
		.catch((error) => {
			console.error('[ai-chat] failed to write the chat store:', error);
		});
	return messageWrites;
}

// ── The device-local message store: a KvStoreHandle over IndexedDB ──────

/**
 * Open a device-local {@link KvStoreHandle} over one conversation's messages,
 * the store the client agent loop (ADR-0047) writes finished messages into.
 *
 * The handle is the structural twin of the Yjs child-doc store
 * (`attachKvStore`): synchronous reads off an in-memory cache, by-id writes, and
 * an `observe` that fires on every change so the loop re-reads. It hydrates the
 * cache from IndexedDB asynchronously and fires `observe` once loaded, the same
 * way the Yjs store repopulates as a doc syncs in; the loop registers its
 * observer synchronously at construction, so a hydrated message always reaches
 * the snapshot. Every write, per-message or whole-conversation, goes through one
 * shared ordered queue, so a delete never races a trailing message write.
 */
export function attachConversationStore(
	conversationId: ConversationId,
): KvStoreHandle<AgentMessage> & Disposable {
	const cache = new Map<string, AgentMessage>();
	const observers = new Set<() => void>();
	let disposed = false;

	function notify(): void {
		for (const observer of observers) observer();
	}

	// Hydrate the cache from IndexedDB, then fire `observe` so the loop reads the
	// stored transcript in. Records written in-memory before hydration finishes
	// (a fast first send) win: hydration never overwrites a key already present.
	void (async () => {
		try {
			const messages = await store(MESSAGES_STORE, 'readonly');
			const range = conversationRange(conversationId);
			const [keys, values] = await Promise.all([
				requestToPromise(messages.getAllKeys(range)),
				requestToPromise<AgentMessage[]>(messages.getAll(range)),
			]);
			if (disposed) return;
			let changed = false;
			keys.forEach((key, i) => {
				const value = values[i];
				const messageId = messageIdOf(String(key));
				if (value !== undefined && !cache.has(messageId)) {
					cache.set(messageId, value);
					changed = true;
				}
			});
			if (changed) notify();
		} catch (error) {
			console.error('[ai-chat] failed to load chat history:', error);
		}
	})();

	return {
		get: (key) => cache.get(key),
		set: (key, value) => {
			cache.set(key, value);
			notify();
			void enqueueMessageWrite((messages) =>
				messages.put(value, messageKey(conversationId, key)),
			);
		},
		delete: (key) => {
			cache.delete(key);
			notify();
			void enqueueMessageWrite((messages) =>
				messages.delete(messageKey(conversationId, key)),
			);
		},
		*entries() {
			for (const [key, val] of cache) yield { key, val };
		},
		observe: (handler) => {
			observers.add(handler);
			return () => observers.delete(handler);
		},
		[Symbol.dispose]() {
			disposed = true;
			observers.clear();
		},
	};
}

// ── Whole-conversation operations ──────────────────────────────────────

/**
 * Delete one conversation's entire message history, range-deleting its rows in
 * one transaction. Routed through the shared write queue so the wipe commits
 * after any finished-message write already queued for that conversation, never
 * before it (which would resurrect a row the delete was meant to remove).
 */
export async function clearConversation(id: ConversationId): Promise<void> {
	await enqueueMessageWrite((messages) =>
		messages.delete(conversationRange(id)),
	);
}

// ── Startup enumeration and model-choice rows ──────────────────────────

/**
 * Discover every stored conversation in one pass: its id and the timestamp of
 * its most recent message, for ordering the list and activating the latest.
 * Each conversation's handle then hydrates its own messages through
 * {@link attachConversationStore}; this scan only finds ids and recency.
 */
export async function loadAllConversations(): Promise<
	Array<{ id: ConversationId; lastActivity: number }>
> {
	try {
		const messages = await store(MESSAGES_STORE, 'readonly');
		const [keys, values] = await Promise.all([
			requestToPromise(messages.getAllKeys()),
			requestToPromise<AgentMessage[]>(messages.getAll()),
		]);
		const lastActivity = new Map<ConversationId, number>();
		keys.forEach((key, i) => {
			const value = values[i];
			if (value === undefined) return;
			const id = conversationIdOf(String(key));
			lastActivity.set(
				id,
				Math.max(lastActivity.get(id) ?? 0, value.createdAt),
			);
		});
		return [...lastActivity].map(([id, last]) => ({ id, lastActivity: last }));
	} catch (error) {
		console.error('[ai-chat] failed to list conversations:', error);
		return [];
	}
}

/** Read every stored model choice in one pass, for startup hydration. */
export async function getAllModelChoices(): Promise<
	Map<ConversationId, ModelChoice>
> {
	try {
		const settings = await store(SETTINGS_STORE, 'readonly');
		const [keys, values] = await Promise.all([
			requestToPromise(settings.getAllKeys()),
			requestToPromise<ModelChoice[]>(settings.getAll()),
		]);
		const choices = new Map<ConversationId, ModelChoice>();
		keys.forEach((key, i) => {
			const value = values[i];
			if (value !== undefined)
				choices.set(asConversationId(String(key)), value);
		});
		return choices;
	} catch (error) {
		console.error('[ai-chat] failed to load model choices:', error);
		return new Map();
	}
}

export async function setModelChoice(
	id: ConversationId,
	choice: ModelChoice,
): Promise<void> {
	try {
		await requestToPromise(
			(await store(SETTINGS_STORE, 'readwrite')).put(choice, id),
		);
	} catch (error) {
		console.error('[ai-chat] failed to save model choice:', error);
	}
}

export async function deleteModelChoice(id: ConversationId): Promise<void> {
	try {
		await requestToPromise(
			(await store(SETTINGS_STORE, 'readwrite')).delete(id),
		);
	} catch (error) {
		console.error('[ai-chat] failed to delete model choice:', error);
	}
}
