/**
 * Node and Bun-only workspace APIs.
 *
 * Keep these exports out of the root `@epicenter/workspace` barrel so browser
 * bundles do not traverse modules that import `node:*` or `bun:*`.
 */

export { connectDaemonActions } from './client/connect-daemon-actions.js';
export type { DaemonActions } from './client/daemon-actions.js';
export { findEpicenterRoot } from './client/find-epicenter-root.js';
export { DEFAULT_EPICENTER_CONFIG_SOURCE } from './config/epicenter-config-source.js';
export { EpicenterConfigError } from './config/load-epicenter-config.js';
export {
	type PeerSyncStatus,
	RunError,
} from './daemon/action-errors.js';
export { PeerSnapshot, RunRequest } from './daemon/app.js';
export {
	type AttachMountInfrastructureOptions,
	attachMountInfrastructure,
} from './daemon/attach-mount-infrastructure.js';
export {
	type DaemonClient,
	DaemonError,
	daemonClient,
	getDaemon,
	pingDaemon,
} from './daemon/client.js';
export {
	defineMount,
	defineSessionMount,
	inactive,
	isInactive,
	type Mount,
	type MountContext,
	type MountInactive,
	type MountSession,
	type SessionMountContext,
} from './daemon/define-mount.js';
export {
	claimDaemonLease,
	type DaemonLease,
} from './daemon/lease.js';
export {
	type DaemonMetadata,
	enumerateDaemons,
	readMetadata,
	unlinkMetadata,
	writeMetadata,
} from './daemon/metadata.js';
export {
	dirHash,
	leasePathFor,
	logPathFor,
	metadataPathFor,
	socketPathFor,
} from './daemon/paths.js';
export { sweepDaemonRuntimeFiles } from './daemon/runtime-files.js';
export {
	type DaemonServer,
	type DaemonServerOptions,
	startDaemonServer,
} from './daemon/server.js';
export { StartupError } from './daemon/startup-errors.js';
export type {
	DaemonRuntime,
	StartedMount,
} from './daemon/types.js';
export {
	attachYjsLog,
	type YjsLogAttachment,
} from './document/attach-yjs-log.js';
export {
	attachYjsLogReader,
	type YjsLogReaderAttachment,
} from './document/attach-yjs-log-reader.js';
export {
	attachGitAutosave,
	type GitAutosave,
	type GitAutosaveConfig,
} from './document/materializer/markdown/git-autosave.js';
export {
	createNodeFs,
	nodeMarkdownDeps,
} from './document/materializer/markdown/node-fs.js';
export {
	type OpenSqliteReaderOptions,
	openSqliteReader,
	type SqliteReader,
} from './document/open-sqlite-reader.js';
export { openWorkspaceSqlite } from './document/open-workspace-sqlite.js';
export {
	markdownPath,
	mountMarkdownPath,
	sqlitePath,
	yjsPath,
} from './document/workspace-paths.js';
export { hashYDocClientId } from './shared/client-id.js';
export type { WorkspaceAuthClient } from './workspace-apps/auth-client.js';
export { WorkspaceAppError } from './workspace-apps/errors.js';
export {
	type InactiveMount,
	type OpenEpicenterRootOptions,
	type OpenedEpicenterRoot,
	openEpicenterRoot,
} from './workspace-apps/open-epicenter-root.js';
