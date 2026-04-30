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
// ACTION SYSTEM + RPC + PEER DISPATCH
// ════════════════════════════════════════════════════════════════════════════
//
// All typed-RPC primitives now live in `@epicenter/sync` (alongside
// `RpcError`, `isRpcError`, and the wire codec). Import them directly
// from there:
//
//   import {
//     defineQuery, defineMutation, peer, describePeer,
//     RpcError, isRpcError,
//   } from '@epicenter/sync';
//
// Workspace deliberately does not re-export them: keeping the boundary
// visible makes it obvious which package owns the contract.

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

export type { AbsolutePath, MaybePromise, ProjectDir } from './shared/types.js';

// ════════════════════════════════════════════════════════════════════════════
// ID UTILITIES
// ════════════════════════════════════════════════════════════════════════════

export type { Guid, Id } from './shared/id.js';
export { Id as createId, generateGuid, generateId } from './shared/id.js';

// ════════════════════════════════════════════════════════════════════════════
// DATE UTILITIES
// ════════════════════════════════════════════════════════════════════════════

export type {
	DateIsoString,
	ParsedDateTimeString,
	TimezoneId,
} from './shared/datetime-string.js';
export { DateTimeString } from './shared/datetime-string.js';

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
// DOCUMENT PRIMITIVES: attach*, define*, createDisposableCache, encryption,
// timeline, storage keys, types: everything in src/document/ + src/cache/
// flows through its barrel.
// ════════════════════════════════════════════════════════════════════════════

export {
	attachIndexedDb,
	type IndexedDbAttachment,
} from './document/attach-indexed-db.js';

export {
	attachYjsLog,
	type YjsLogAttachment,
} from './document/attach-yjs-log.js';

export { SqliteWriterPragmaError } from './document/sqlite-writer-pragmas.js';

export {
	attachYjsLogReader,
	type YjsLogReaderAttachment,
} from './document/attach-yjs-log-reader.js';

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
	type WebSocketImpl,
} from './document/attach-sync.js';

export { NoopWebSocket } from './document/noop-ws.js';

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
//
// CLI-lifecycle plumbing: buildApp, daemon client, runtime path helpers
// (sockets, metadata, log). Per-workspace data layout helpers (yjs, sqlite,
// markdown) live in the WORKSPACE PATHS section below.

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
} from './daemon/client.js';
export {
	dirHash,
	logPathFor,
	metadataPathFor,
	runtimeDir,
	socketPathFor,
} from './daemon/paths.js';

// ════════════════════════════════════════════════════════════════════════════
// WORKSPACE PATHS (per-workspace data layout)
// ════════════════════════════════════════════════════════════════════════════

export {
	markdownPath,
	sqlitePath,
	yjsPath,
} from './document/workspace-paths.js';
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

// ════════════════════════════════════════════════════════════════════════════
// CLIENT (remote workspace proxy)
// ════════════════════════════════════════════════════════════════════════════
//
// connectDaemon is the script-author entry point for talking to a
// running daemon. The proxy guts (buildRemoteWorkspace) and helpers
// are exported for tests and tooling.

export { buildRemoteWorkspace } from './client/remote.js';
export { connectDaemon } from './client/connect-daemon.js';
export { findEpicenterDir } from './client/find-epicenter-dir.js';
export type { Remote } from './client/remote-workspace-types.js';
export {
	attachSqliteReader,
	type AttachSqliteReaderOptions,
	type SqliteReaderAttachment,
} from './document/attach-sqlite-reader.js';

// ════════════════════════════════════════════════════════════════════════════
// CLIENT-ID DERIVATION
// ════════════════════════════════════════════════════════════════════════════
//
// Stable Yjs clientID hint for ephemeral peers (vault scripts). Keeps the
// daemon's state vector bounded by the count of distinct mutating scripts
// rather than the count of invocations.

export { hashClientId } from './shared/client-id.js';

// ════════════════════════════════════════════════════════════════════════════
// SCHEMA HELPERS
// ════════════════════════════════════════════════════════════════════════════

export { partialUpdate } from './shared/schema-partial.js';
