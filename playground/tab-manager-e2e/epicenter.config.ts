/**
 * E2E playground config: syncs the tab-manager workspace from the Epicenter API
 * down to local persistence (SQLite) and materializes to markdown files.
 *
 * Reads auth credentials (token + encryption keys) from the CLI session store
 * at `~/.epicenter/auth/sessions.json`—run `epicenter auth login` first.
 *
 * Exports `tabManager` — an object satisfying `LoadedWorkspace` with
 * `whenReady`, `sync`, and `[Symbol.dispose]`. No `actions` because no
 * defineQuery/defineMutation wrappers are attached at the playground layer
 * (the tab-manager extension defines actions, not this config).
 *
 * Usage:
 *   # Run the workspace — imports this config, which constructs the
 *   # workspace, starting persistence + sync + markdown materialization.
 *   # Runs until Ctrl+C.
 *   bun run playground/tab-manager-e2e/epicenter.config.ts
 *
 *   # `epicenter list` against this config shows an empty tree — no
 *   # actions exposed here.
 */

import { join } from 'node:path';
import {
	attachSessionUnlock,
	createSessionStore,
} from '@epicenter/cli';
import {
	tabManagerAwarenessDefs,
	tabManagerTables,
} from '@epicenter/tab-manager/workspace';
import {
	attachEncryption,
	attachSqlite,
	attachSync,
	persistencePath,
} from '@epicenter/workspace';
import {
	attachMarkdownMaterializer,
	slugFilename,
} from '@epicenter/workspace/document/materializer/markdown';
import * as Y from 'yjs';

const SERVER_URL = 'https://api.epicenter.so';
const MARKDOWN_DIR = join(import.meta.dir, 'data');
const WORKSPACE_ID = 'epicenter.tab-manager';

const sessions = createSessionStore();

const ydoc = new Y.Doc({ guid: WORKSPACE_ID, gc: false });
const encryption = attachEncryption(ydoc);
const tables = encryption.attachTables(ydoc, tabManagerTables);
// Empty kv — tabManager has no KV definitions, but `.kv()` on the materializer
// serializes the shared kv store. Keep an empty encrypted kv attached so the
// materializer's `.kv()` call has something to observe.
const kv = encryption.attachKv(ydoc, {});

const persistence = attachSqlite(ydoc, {
	filePath: persistencePath(import.meta.dir, WORKSPACE_ID),
});

const unlock = attachSessionUnlock(encryption, {
	sessions,
	serverUrl: SERVER_URL,
	waitFor: persistence.whenLoaded,
});

const sync = attachSync(ydoc, {
	url: (docId) => `${SERVER_URL}/workspaces/${docId}`,
	// Gate connection on local hydrate + unlock so the handshake only exchanges
	// the delta, not the whole document.
	waitFor: Promise.all([persistence.whenLoaded, unlock.whenChecked]),
	getToken: async () => (await sessions.load(SERVER_URL))?.accessToken ?? null,
});

const whenReady = Promise.all([
	persistence.whenLoaded,
	unlock.whenChecked,
	sync.whenConnected,
]);

const markdown = attachMarkdownMaterializer(
	{ tables, kv, whenReady },
	{ dir: MARKDOWN_DIR },
)
	.table('savedTabs', { filename: slugFilename('title') })
	.table('bookmarks', { filename: slugFilename('title') })
	.table('devices')
	.kv();

export const tabManager = {
	whenReady,
	sync,
	[Symbol.dispose]() {
		ydoc.destroy();
	},
	// extras (not part of LoadedWorkspace contract)
	id: WORKSPACE_ID,
	ydoc,
	tables,
	kv,
	awarenessDefs: tabManagerAwarenessDefs,
	encryption,
	persistence,
	markdown,
};
