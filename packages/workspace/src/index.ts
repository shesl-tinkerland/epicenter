/**
 * Epicenter: YJS-First Collaborative Workspace System
 *
 * This root export provides the full workspace API and shared utilities.
 *
 * - `@epicenter/workspace` - Full API (documents, tables, KV, attachments)
 *
 * @example
 * ```typescript
 * import { attachTables, createDisposableCache, defineTable } from '@epicenter/workspace';
 * import { type } from 'arktype';
 *
 * const posts = defineTable(type({ id: 'string', title: 'string', _v: '1' }));
 *
 * // Singleton workspace: inline at module scope, no factory wrapper.
 * const ydoc = new Y.Doc({ guid: 'notes' });
 * const tables = attachTables(ydoc, { posts });
 *
 * // Per-row docs: createDisposableCache wraps a pure builder.
 * const noteBodyDocs = createDisposableCache(
 *   (noteId) => buildNoteBody({ noteId, notesTable: tables.posts }),
 *   { gcTime: 5_000 },
 * );
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
	RemoteActions,
} from './shared/actions';
export {
	defineMutation,
	defineQuery,
	describeActions,
	invokeAction,
	isAction,
	resolveActionPath,
	walkActions,
} from './shared/actions';

// ════════════════════════════════════════════════════════════════════════════
// RPC + PEER DISPATCH
// ════════════════════════════════════════════════════════════════════════════

export type { InferRpcMap, RpcActionMap } from './rpc/types';
export { isRpcError, RpcError } from '@epicenter/sync';

// Peer dispatch (cross-device action calling) — see `peer<T>(workspace, deviceId)`.
export { peer, describePeer } from './rpc/peer.js';
export type { RemoteCallOptions } from './shared/actions.js';

// ════════════════════════════════════════════════════════════════════════════
// DEVICE IDENTITY
// ════════════════════════════════════════════════════════════════════════════

export {
	type AsyncStorage,
	getOrCreateDeviceId,
	getOrCreateDeviceIdAsync,
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
// which breaks SvelteKit/Vite ssr→client builds (see `__vite-browser-external`
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
// DOCUMENT PRIMITIVES — attach*, define*, createDisposableCache, encryption,
// timeline, storage keys, types — everything in src/document/ + src/cache/
// flows through its barrel.
// ════════════════════════════════════════════════════════════════════════════

export {
	attachIndexedDb,
	type IndexedDbAttachment,
} from './document/attach-indexed-db.js';

export {
	attachSqlite,
	type SqliteAttachment,
} from './document/attach-sqlite.js';

export {
	attachBroadcastChannel,
	BC_ORIGIN,
	type BroadcastChannelAttachment,
} from './document/attach-broadcast-channel.js';

export {
	attachRichText,
	xmlFragmentToPlaintext,
	type RichTextAttachment,
} from './document/attach-rich-text.js';

export {
	attachPlainText,
	type PlainTextAttachment,
} from './document/attach-plain-text.js';

export {
	attachSync,
	PeerMiss,
	SyncFailedError,
	toWsUrl,
	type AttachSyncDoc,
	type SyncAttachment,
	type SyncAttachmentConfig,
	type SyncFailedReason,
	type SyncStatus,
	type WaitForBarrier,
} from './document/attach-sync.js';

export {
	attachTable,
	attachTables,
	type BaseRow,
	type InferTableRow,
	type LastSchema,
	type Table,
	type TableDefinition,
	type TableDefinitions,
	TableParseError,
	type Tables,
} from './document/attach-table.js';

export {
	attachKv,
	type InferKvValue,
	type Kv,
	type KvChange,
	type KvDefinition,
	type KvDefinitions,
} from './document/attach-kv.js';

export {
	type DeviceDescriptor,
	type FoundPeer,
	type PeerAwarenessState,
	PeerDevice,
	Platform,
} from './document/standard-awareness-defs.js';

export {
	attachAwareness,
	type Awareness,
	type AwarenessDefinitions,
	type AwarenessState,
	type InferAwarenessValue,
} from './document/attach-awareness.js';

export type { CombinedStandardSchema } from './document/standard-schema.js';

export {
	attachTimeline,
	computeMidpoint,
	generateInitialOrders,
	parseSheetFromCsv,
	populateFragmentFromText,
	serializeSheetToCsv,
	type ContentType,
	type RichTextEntry,
	type SheetBinding,
	type SheetEntry,
	type TextEntry,
	type Timeline,
	type TimelineEntry,
} from './document/attach-timeline/index.js';

export {
	createDisposableCache,
	type DisposableCache,
	DisposableCacheError,
} from './cache/disposable-cache.js';
export { defineTable } from './document/define-table.js';
export { defineKv } from './document/define-kv.js';
export { docGuid } from './document/doc-guid.js';
export { type DocPersistence } from './document/doc-persistence.js';
export { onLocalUpdate } from './document/on-local-update.js';

export {
	attachEncryption,
	type EncryptionAttachment,
} from './document/attach-encryption.js';
export {
	EncryptionKey,
	EncryptionKeys,
	encryptionKeysFingerprint,
} from './document/encryption-key.js';

export { KV_KEY, TableKey, type KvKey } from './document/keys.js';
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

// ════════════════════════════════════════════════════════════════════════════
// DAEMON (unix socket transport)
// ════════════════════════════════════════════════════════════════════════════

export type { LoadedWorkspace, WorkspaceEntry } from './daemon/types.js';
export {
	buildApp,
	ListInput,
	PeerSnapshot,
	RunInput,
} from './daemon/app.js';
export {
	DaemonError,
	type DaemonClient,
	daemonClient,
	getDaemon,
	pingDaemon,
	type ResolvedTarget,
} from './daemon/client.js';
export {
	dirHash,
	logPathFor,
	metadataPathFor,
	runtimeDir,
	socketPathFor,
} from './daemon/paths.js';
export {
	type DaemonMetadata,
	readMetadata,
	unlinkMetadata,
	writeMetadata,
} from './daemon/metadata.js';
export {
	ResolveError,
} from './daemon/resolve-entry.js';
export {
	RunError,
	type RunResponse,
} from './daemon/run-errors.js';
export {
	bindOrRecover,
	bindUnixSocket,
	StartupError,
	type UnixSocketServer,
	unlinkSocketFile,
} from './daemon/unix-socket.js';
export {
	createWorkspaceServer,
	type WorkspaceServer,
	type WorkspaceServerOptions,
} from './daemon/server.js';
export { buildTableActions } from './daemon/table-actions.js';

// ════════════════════════════════════════════════════════════════════════════
// CLIENT (remote workspace proxy)
// ════════════════════════════════════════════════════════════════════════════

export { buildRemoteWorkspace } from './client/remote.js';
export { RemoteNotSupported } from './client/remote-not-supported.js';
export type {
	RemoteAction,
	RemoteCallError,
	RemoteTable,
	RemoteWorkspace,
} from './client/remote-workspace-types.js';

// ════════════════════════════════════════════════════════════════════════════
// SCHEMA HELPERS
// ════════════════════════════════════════════════════════════════════════════

export { partialOf, type PartialOf } from './shared/schema-partial.js';

// ════════════════════════════════════════════════════════════════════════════
// PATHS
// ════════════════════════════════════════════════════════════════════════════

export { persistencePath } from './paths/persistence.js';
