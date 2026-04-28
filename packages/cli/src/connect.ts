/**
 * `connectWorkspace`: bundle the standard Epicenter cloud chain (SQLite
 * persistence at `~/.epicenter/persistence`, session-based unlock from the
 * stored CLI session, and sync to the configured server) for a workspace.
 *
 * Scripts and `epicenter.config.ts` files use this to skip the 15-line
 * persistence + unlock + sync ceremony. Workspace-specific concerns
 * (tables, kv, materializers, actions, per-row caches) stay caller-owned.
 *
 * Requires a prior `epicenter auth login` so a session exists at
 * `~/.epicenter/auth/sessions.json`. Without one, the chain still wires up
 * correctly but anonymous mode is in effect (no encryption keys applied).
 *
 * @example
 * ```ts
 * import { attachEncryption } from '@epicenter/workspace';
 * import { connectWorkspace } from '@epicenter/cli';
 * import * as Y from 'yjs';
 *
 * const ydoc = new Y.Doc({ guid: 'my-workspace', gc: false });
 * const encryption = attachEncryption(ydoc);
 * const tables = encryption.attachTables(ydoc, mySchema);
 *
 * const { persistence, unlock, sync, whenReady } = connectWorkspace({
 *   ydoc,
 *   encryption,
 * });
 *
 * await whenReady;
 * // tables.* is hydrated from local persistence and synced with the server.
 * ```
 */

import type {
	EncryptionAttachment,
	SqliteAttachment,
	SyncAttachment,
} from '@epicenter/workspace';
import { attachSqlite, attachSync, toWsUrl } from '@epicenter/workspace';
import * as Y from 'yjs';

import {
	attachSessionUnlock,
	type SessionUnlockAttachment,
} from './auth/attach-session-unlock.js';
import { epicenterPaths } from './auth/paths.js';
import { createSessionStore } from './auth/session-store.js';

const DEFAULT_SERVER_URL = 'https://api.epicenter.so';

export type ConnectWorkspaceOptions = {
	/** The workspace's Y.Doc. Its `guid` is used as the persistence and sync identifier. */
	ydoc: Y.Doc;
	/** The encryption attachment whose keys the unlock chain will populate from the session. */
	encryption: EncryptionAttachment;
	/** Server URL. Defaults to `process.env.EPICENTER_SERVER` then `'https://api.epicenter.so'`. */
	serverUrl?: string;
};

export type ConnectedWorkspace = {
	persistence: SqliteAttachment;
	unlock: SessionUnlockAttachment;
	sync: SyncAttachment;
	/** Resolves once persistence, unlock, and the first sync handshake have all completed. */
	whenReady: Promise<unknown>;
};

export function connectWorkspace({
	ydoc,
	encryption,
	serverUrl = process.env.EPICENTER_SERVER ?? DEFAULT_SERVER_URL,
}: ConnectWorkspaceOptions): ConnectedWorkspace {
	const sessions = createSessionStore();

	const persistence = attachSqlite(ydoc, {
		filePath: epicenterPaths.persistence(ydoc.guid),
	});

	const unlock = attachSessionUnlock(encryption, {
		sessions,
		serverUrl,
		waitFor: persistence.whenLoaded,
	});

	const sync = attachSync(ydoc, {
		url: toWsUrl(`${serverUrl}/workspaces/${ydoc.guid}`),
		waitFor: Promise.all([persistence.whenLoaded, unlock.whenChecked]),
		getToken: async () => (await sessions.load(serverUrl))?.accessToken ?? null,
	});

	const whenReady = Promise.all([
		persistence.whenLoaded,
		unlock.whenChecked,
		sync.whenConnected,
	]);

	return { persistence, unlock, sync, whenReady };
}
