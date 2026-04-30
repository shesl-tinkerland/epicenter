/**
 * Script-side factory for the Opensidian workspace.
 *
 * Short-lived peers (one-shot CLI scripts, migrations, vault tools) read the
 * daemon's persistence file `{ readonly: true }` for warm hydrate, then run
 * their own cloud-sync attachment. Their writes flow through cloud; the
 * daemon picks them up via its own `attachSync` and writes to disk.
 *
 * Pairs with `daemon.ts` (long-lived materializer worker that owns the
 * persistence file) and `browser.ts` (Svelte UI).
 */

import {
	attachSqliteReadonlyPersistence,
	attachSync,
	findEpicenterDir,
	hashClientId,
	isMissingFile,
	persistencePath,
	toWsUrl,
} from '@epicenter/workspace';
import { openOpensidian as openOpensidianDoc } from './index.js';

const SERVER_URL = 'https://api.epicenter.so';

function resolveDir(): string {
	try {
		return findEpicenterDir();
	} catch {
		return process.cwd();
	}
}

export async function openOpensidian({
	getToken,
	absDir,
	clientID = hashClientId(Bun.main),
	webSocketImpl,
}: {
	getToken: () => string | null | Promise<string | null>;
	/**
	 * Project root. Defaults to the nearest ancestor of `process.cwd()` that
	 * contains `epicenter.config.ts` or `.epicenter/`; falls back to
	 * `process.cwd()` if no marker is found. Scripts run outside a vault
	 * therefore boot with no warm hydrate (the persistence file won't exist
	 * under cwd) and cold-sync from cloud.
	 */
	absDir?: string;
	/**
	 * Y.Doc clientID for this script. Defaults to `hashClientId(Bun.main)`
	 * so two invocations of the same script reuse the same clientID and
	 * their writes merge under Yjs causality. Override for tests, debugging,
	 * or scripts that genuinely want a fresh peer identity per run.
	 */
	clientID?: number;
	/**
	 * WebSocket constructor for `attachSync`. Tests pass a stub to avoid
	 * dialing real servers; production omits it.
	 */
	webSocketImpl?: typeof WebSocket;
}) {
	const resolvedDir = absDir ?? resolveDir();

	const doc = openOpensidianDoc({ clientID });

	const filePath = persistencePath(resolvedDir, doc.ydoc.guid);
	const persistence = attachSqliteReadonlyPersistence(doc.ydoc, { filePath });

	// Swallow `MissingFile` (no daemon has written here yet: fall through to
	// cold cloud sync); re-throw every other error.
	const hydrate = persistence.whenLoaded.catch((err: unknown) => {
		if (!isMissingFile(err)) throw err;
	});

	const sync = attachSync(doc, {
		url: toWsUrl(`${SERVER_URL}/workspaces/${doc.ydoc.guid}`),
		waitFor: hydrate,
		getToken,
		webSocketImpl,
	});

	await hydrate;

	return {
		...doc,
		persistence,
		sync,
	};
}
