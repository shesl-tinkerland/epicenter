/**
 * Node and Bun-only workspace APIs.
 *
 * Keep these exports out of the root `@epicenter/workspace` barrel so browser
 * bundles do not traverse modules that import `node:*` or `bun:*`.
 */

export { connectDaemonActions } from './client/connect-daemon-actions.js';
export type { DaemonActions } from './client/daemon-actions.js';
export { buildDaemonActions } from './client/daemon-actions.js';
export { findEpicenterRoot } from './client/find-project-root.js';
export {
	type PeerSyncStatus,
	RunError,
} from './daemon/action-errors.js';
export { PeerSnapshot, RunRequest } from './daemon/app.js';
export {
	type AttachProjectInfrastructureOptions,
	attachProjectInfrastructure,
	type ProjectInfrastructure,
} from './daemon/attach-project-infrastructure.js';
export {
	type DaemonClient,
	DaemonError,
	daemonClient,
	getDaemon,
	pingDaemon,
} from './daemon/client.js';
export {
	claimDaemonLease,
	type DaemonLease,
} from './daemon/lease.js';
export {
	type DaemonMetadata,
	enumerateDaemons,
	readMetadata,
	readMetadataFromPath,
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
export {
	attachYjsLog,
	type YjsLogAttachment,
} from './document/attach-yjs-log.js';
export {
	attachYjsLogReader,
	type YjsLogReaderAttachment,
} from './document/attach-yjs-log-reader.js';
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
export type { WorkspaceAuthClient } from './mount/auth-client.js';
export { DEFAULT_PROJECT_CONFIG_SOURCE } from './mount/config-source.js';
export type {
	DaemonRuntime,
	StartedMount,
} from './mount/contract.js';
export {
	defineMount,
	type Mount,
	type MountContext,
} from './mount/contract.js';
export { ProjectConfigError } from './mount/load-config.js';
export {
	type OpenProjectOptions,
	openProject,
} from './mount/open.js';
export { WorkspaceAppError } from './mount/open-errors.js';
export { hashYDocClientId } from './shared/client-id.js';
