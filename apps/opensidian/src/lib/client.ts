import { APP_URLS } from '@epicenter/constants/vite';
import { createAuth } from '@epicenter/svelte/auth';
import {
	createSqliteIndex,
	createYjsFileSystem,
} from '@epicenter/filesystem';
import { createSyncExtension, toWsUrl } from '@epicenter/workspace/extensions/sync/websocket';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/persistence/indexeddb';
import { Bash } from 'just-bash';
import { session } from '$lib/auth';
import { createIndexedDbKeyStore } from '@epicenter/svelte-utils';
import { createOpensidian } from './workspace/workspace';

/**
 * Opensidian workspace infrastructure.
 *
 * Creates the Yjs workspace, filesystem abstraction, and extensions.
 * Imported by both fs-state.svelte.ts (for reactive wrappers) and
 * components that need direct infra access (Toolbar, ContentEditor).
 */
export const workspace = createOpensidian()
	.withEncryption({ userKeyStore: createIndexedDbKeyStore('opensidian:encryption-key') })
	.withExtension('persistence', indexeddbPersistence)
	.withExtension(
		'sync',
		createSyncExtension({
			url: (workspaceId) => toWsUrl(`${APP_URLS.API}/workspaces/${workspaceId}`),
			getToken: async () => auth.token,
		}),
	)
	.withWorkspaceExtension('sqliteIndex', createSqliteIndex());

export const auth = createAuth({
	baseURL: APP_URLS.API,
	session,
	onLogin(session) {
		workspace.unlockWithKeys(session.encryptionKeys);
		workspace.extensions.sync.reconnect();
	},
	onLogout() {
		workspace.clearLocalData();
		workspace.extensions.sync.reconnect();
	},
});

/** Yjs-backed virtual filesystem with path-based operations. */
export const fs = createYjsFileSystem(
	workspace.tables.files,
	workspace.documents.files.content,
);

/**
 * Shell emulator backed by the Yjs virtual filesystem.
 *
 * Executes `just-bash` commands against the same `fs` used by the UI,
 * so files created via `echo "x" > /foo.md` are immediately visible
 * in the file tree. Shell state (env, cwd) resets between `exec()` calls.
 *
 * @example
 * ```typescript
 * const result = await bash.exec('echo "hello" > /greeting.md');
 * const cat = await bash.exec('cat /greeting.md');
 * console.log(cat.stdout); // "hello\n"
 * ```
 */
export const bash = new Bash({ fs, cwd: '/' });
