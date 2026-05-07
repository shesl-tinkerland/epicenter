/**
 * Epicenter: YJS-First Collaborative Workspace System
 *
 * This root export provides the browser-safe workspace API and shared
 * utilities.
 *
 * - `@epicenter/workspace`: browser-safe API (documents, tables, KV, sync)
 *
 * @example
 * ```typescript
 * import {
 *   attachIndexedDb,
 *   attachRichText,
 *   attachSync,
 *   attachTables,
 *   createDisposableCache,
 *   defineTable,
 *   docGuid,
 * } from '@epicenter/workspace';
 * import { type } from 'arktype';
 * import * as Y from 'yjs';
 *
 * const posts = defineTable(type({ id: 'string', title: 'string', _v: '1' }));
 * declare const bearerToken: () => string | null;
 *
 * // Singleton workspace: inline at module scope, no factory wrapper.
 * const ydoc = new Y.Doc({ guid: 'notes' });
 * const tables = attachTables(ydoc, { posts });
 * const idb = attachIndexedDb(ydoc);
 * const sync = attachSync(ydoc, {
 *   url: `wss://api.example.com/workspaces/${ydoc.guid}`,
 *   waitFor: idb,
 *   bearerToken,
 * });
 *
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
 *     return {
 *       ydoc: bodyYdoc,
 *       body: attachRichText(bodyYdoc),
 *       idb: bodyIdb,
 *       [Symbol.dispose]() {
 *         bodyYdoc.destroy();
 *       },
 *     };
 *   },
 *   { gcTime: 5_000 },
 * );
 * async function clearNoteBodyLocalData() {
 *   await Promise.all(
 *     tables.posts.getAllValid().map((post) => clearStoredNoteBody(post.id)),
 *   );
 * }
 * ```
 *
 * @packageDocumentation
 */

// ════════════════════════════════════════════════════════════════════════════
// ACTION SYSTEM
// ════════════════════════════════════════════════════════════════════════════

export type {
	Action,
	ActionManifest,
	ActionMeta,
	Actions,
	Mutation,
	Query,
	RemoteActionProxy,
} from './shared/actions';
export {
	defineMutation,
	defineQuery,
	describeActions,
	invokeAction,
	invokeActionForRpc,
	isAction,
	resolveActionPath,
	walkActions,
} from './shared/actions';

// ════════════════════════════════════════════════════════════════════════════
// RPC + REMOTE ACTIONS
// ════════════════════════════════════════════════════════════════════════════

export type { EncryptionKeys } from '@epicenter/encryption';
export { isRpcError, RpcError } from '@epicenter/sync';
// Cross-peer action calling.
export {
	createRemoteClient,
	PeerAddressError,
	type RemoteCallError,
	type RemoteClient,
	type RemoteClientOptions,
	type RemotePeerCallOptions,
	type WireRpcError,
} from './rpc/remote-actions.js';
export type { InferSyncRpcMap, RpcActionMap } from './rpc/types';
export type { RemoteCallOptions } from './shared/actions.js';

// ════════════════════════════════════════════════════════════════════════════
// DEVICE IDENTITY
// ════════════════════════════════════════════════════════════════════════════

export {
	type AsyncStorage,
	getOrCreateInstallationId,
	getOrCreateInstallationIdAsync,
	type SimpleStorage,
} from './shared/device-id.js';

// ════════════════════════════════════════════════════════════════════════════
// SHARED TYPES
// ════════════════════════════════════════════════════════════════════════════

export type { MaybePromise } from './shared/types';

// ════════════════════════════════════════════════════════════════════════════
// ERROR TYPES
// ════════════════════════════════════════════════════════════════════════════

export { ExtensionError } from './shared/errors';

// JSONL file sink (Bun-only) lives at the `@epicenter/workspace/logger/jsonl-sink`
// subpath. Keeping it out of this barrel matters: re-exporting it pulls
// `node:fs`/`node:path` into every browser bundle that touches `@epicenter/workspace`,
// which breaks SvelteKit/Vite SSR to client builds (see `__vite-browser-external`
// "mkdirSync is not exported" errors). Import the sink directly from the subpath
// in Bun/Node entry points; the logger core (`createLogger`, `consoleSink`, etc.)
// still comes from `wellcrafted/logger`.

// ════════════════════════════════════════════════════════════════════════════
// CORE TYPES
// ════════════════════════════════════════════════════════════════════════════

export type { AbsolutePath, ProjectDir } from './shared/types';

// ════════════════════════════════════════════════════════════════════════════
// ID UTILITIES
// ════════════════════════════════════════════════════════════════════════════

export type { Guid, Id } from './shared/id';
export { generateGuid, generateId, Id as createId } from './shared/id';

// ════════════════════════════════════════════════════════════════════════════
// DATE UTILITIES
// ════════════════════════════════════════════════════════════════════════════

export type {
	DateIsoString,
	ParsedDateTimeString,
	TimezoneId,
} from './shared/datetime-string';
export { DateTimeString } from './shared/datetime-string';

// ════════════════════════════════════════════════════════════════════════════
// DOCUMENT PRIMITIVES: attach*, define*, refcounted cache, encryption,
// timeline, storage keys, types: everything in src/document/ + src/cache/
// flows through its barrel.
// ════════════════════════════════════════════════════════════════════════════

export {
	createDisposableCache,
	type DisposableCache,
	DisposableCacheError,
} from './cache/disposable-cache.js';
export {
	type AwarenessAttachment,
	type AwarenessSchema,
	type AwarenessState,
	attachAwareness,
	type InferAwarenessValue,
} from './document/attach-awareness.js';

export {
	attachBroadcastChannel,
	attachOwnedBroadcastChannel,
	BC_ORIGIN,
} from './document/attach-broadcast-channel.js';
export {
	type AttachEncryptionOptions,
	attachEncryption,
	type EncryptionAttachment,
} from './document/attach-encryption.js';
export {
	attachIndexedDb,
	type IndexedDbAttachment,
	wipeOwnerLocalYjsData,
} from './document/attach-indexed-db.js';
export {
	attachKv,
	type InferKvValue,
	type Kv,
	type KvChange,
	type KvDefinition,
	type KvDefinitions,
} from './document/attach-kv.js';
export {
	attachPlainText,
	type PlainTextAttachment,
} from './document/attach-plain-text.js';
export {
	attachRichText,
	type RichTextAttachment,
	xmlFragmentToPlaintext,
} from './document/attach-rich-text.js';
export {
	type AttachSyncDoc,
	attachSync,
	type RpcActionSource,
	type SyncAttachment,
	type SyncAttachmentConfig,
	SyncFailedError,
	type SyncFailedReason,
	type SyncRpcAttachment,
	type SyncStatus,
	toWsUrl,
	type WaitForBarrier,
} from './document/attach-sync.js';
export {
	attachReadonlyTable,
	attachReadonlyTables,
	attachTable,
	attachTables,
	type BaseRow,
	type InferTableRow,
	type LastSchema,
	type ReadonlyTable,
	type ReadonlyTables,
	type Table,
	type TableDefinition,
	type TableDefinitions,
	TableParseError,
	type Tables,
} from './document/attach-table.js';
export {
	attachTimeline,
	type ContentType,
	computeMidpoint,
	generateInitialOrders,
	parseSheetFromCsv,
	populateFragmentFromText,
	type RichTextEntry,
	type SheetBinding,
	type SheetEntry,
	serializeSheetToCsv,
	type TextEntry,
	type Timeline,
	type TimelineEntry,
} from './document/attach-timeline/index.js';
export { defineKv } from './document/define-kv.js';
export { defineTable } from './document/define-table.js';
export { docGuid } from './document/doc-guid.js';
export { KV_KEY, type KvKey, TableKey } from './document/keys.js';
export { onLocalUpdate } from './document/on-local-update.js';
export {
	type PeerAwarenessSchema,
	type PeerAwarenessState,
	PeerIdentity,
	type PeerRuntime,
	type ResolvedPeer,
} from './document/peer-identity.js';
export type { CombinedStandardSchema } from './document/standard-schema.js';
// ════════════════════════════════════════════════════════════════════════════
// EPICENTER LINKS
// ════════════════════════════════════════════════════════════════════════════

export {
	convertEpicenterLinksToWikilinks,
	convertWikilinksToEpicenterLinks,
	EPICENTER_LINK_RE,
	type EpicenterLink,
	isEpicenterLink,
	makeEpicenterLink,
	parseEpicenterLink,
} from './links.js';
