/**
 * Epicenter: YJS-First Collaborative Workspace System
 *
 * `@epicenter/workspace` attaches typed primitives: tables, KV, plain/rich
 * text, presence, timeline, and an action registry to a `Y.Doc`, then
 * wires the result to IndexedDB persistence, end-to-end encryption, and
 * WebSocket sync via `openCollaboration`.
 *
 * @example
 * ```typescript
 * import {
 *   attachIndexedDb,
 *   attachRichText,
 *   attachTables,
 *   createDisposableCache,
 *   createReplicaId,
 *   defineTable,
 *   docGuid,
 *   openCollaboration,
 *   roomWsUrl,
 * } from '@epicenter/workspace';
 * import { type } from 'arktype';
 * import * as Y from 'yjs';
 *
 * const posts = defineTable(type({ id: 'string', title: 'string', _v: '1' }));
 * declare const openWebSocket: (
 *   url: string | URL,
 *   protocols?: string[],
 * ) => Promise<WebSocket>;
 *
 * const replicaId = createReplicaId({ storage: localStorage });
 *
 * // Singleton document + collaboration: inline at module scope, no factory wrapper.
 * const ydoc = new Y.Doc({ guid: 'notes' });
 * const tables = attachTables(ydoc, { posts });
 * const idb = attachIndexedDb(ydoc);
 * const collaboration = openCollaboration(ydoc, {
 *   url: roomWsUrl('https://api.example.com', ydoc.guid),
 *   waitFor: idb.whenLoaded,
 *   openWebSocket,
 *   replicaId,
 *   actions: {},
 * });
 *
 * // Content docs use the same primitive with an empty action registry.
 * const noteBodyDocs = createDisposableCache(
 *   (noteId: string) => {
 *     const bodyYdoc = new Y.Doc({
 *       guid: docGuid({
 *         workspaceId: ydoc.guid,
 *         collection: 'posts',
 *         rowId: noteId,
 *         field: 'body',
 *       }),
 *       gc: false,
 *     });
 *     const bodyIdb = attachIndexedDb(bodyYdoc);
 *     const bodySync = openCollaboration(bodyYdoc, {
 *       url: roomWsUrl('https://api.example.com', bodyYdoc.guid),
 *       waitFor: bodyIdb.whenLoaded,
 *       openWebSocket,
 *       replicaId,
 *       actions: {},
 *     });
 *     return {
 *       ydoc: bodyYdoc,
 *       body: attachRichText(bodyYdoc),
 *       idb: bodyIdb,
 *       sync: bodySync,
 *       [Symbol.dispose]() {
 *         bodyYdoc.destroy();
 *       },
 *     };
 *   },
 *   { gcTime: 5_000 },
 * );
 * ```
 *
 * @packageDocumentation
 */

// ════════════════════════════════════════════════════════════════════════════
// ACTION SYSTEM
// ════════════════════════════════════════════════════════════════════════════

export type { Action, ActionManifest } from './shared/actions';
export {
	defineActions,
	defineMutation,
	defineQuery,
} from './shared/actions';

// ════════════════════════════════════════════════════════════════════════════
// REPLICA IDENTITY
// ════════════════════════════════════════════════════════════════════════════

export {
	createReplicaId,
	createReplicaIdAsync,
} from './document/replica-id.js';

// ════════════════════════════════════════════════════════════════════════════
// PATH TYPES (for daemon callers)
// ════════════════════════════════════════════════════════════════════════════

export type { ProjectDir } from './shared/types';

// ════════════════════════════════════════════════════════════════════════════
// ID + DATE PRIMITIVES
// ════════════════════════════════════════════════════════════════════════════

export { DateTimeString } from './shared/datetime-string';
export type { Guid, Id } from './shared/id';
export { generateGuid, generateId } from './shared/id';

// ════════════════════════════════════════════════════════════════════════════
// DOCUMENT PRIMITIVES
// ════════════════════════════════════════════════════════════════════════════

export {
	createDisposableCache,
	type DisposableCache,
} from './cache/disposable-cache.js';

export { attachBroadcastChannel } from './document/attach-broadcast-channel.js';
export { attachEncryption } from './document/attach-encryption.js';
export { attachIndexedDb } from './document/attach-indexed-db.js';
export {
	attachKv,
	type InferKvValue,
	type Kv,
	type KvDefinitions,
} from './document/attach-kv.js';
export { attachPlainText } from './document/attach-plain-text.js';
export { attachRichText } from './document/attach-rich-text.js';
export {
	attachTable,
	attachTables,
	type BaseRow,
	type InferTableRow,
	type Table,
	type Tables,
} from './document/attach-table.js';
export { attachTimeline } from './document/attach-timeline/index.js';
export { defineKv } from './document/define-kv.js';
export { defineTable } from './document/define-table.js';
export { docGuid } from './document/doc-guid.js';
export {
	type OpenWebSocket,
	type SyncStatus,
} from './document/internal/sync-supervisor.js';
export {
	createLocalOwner,
	type LocalOwner,
} from './document/local-owner.js';
export { onLocalUpdate } from './document/on-local-update.js';
export {
	type Collaboration,
	openCollaboration,
} from './document/open-collaboration.js';
export { type PresenceEntry } from './document/presence.js';
export { DispatchError } from './document/rpc.js';
export { roomWsUrl, websocketUrl } from './document/transport.js';
