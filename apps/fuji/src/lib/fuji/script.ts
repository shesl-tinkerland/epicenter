/**
 * Script-side factory for the Fuji workspace.
 *
 * Short-lived peers (one-shot CLI scripts, migrations, vault tools) read the
 * daemon's persistence file `{ readonly: true }` for warm hydrate, then run
 * their own cloud-sync attachment. Their writes flow through cloud; the
 * daemon picks them up via its own `attachSync` and writes to disk.
 *
 * No IPC. No coordination. The persistence read races nothing because
 * scripts never write to that file.
 *
 * Pairs with `daemon.ts` (long-lived materializer worker that owns the
 * persistence file) and `browser.ts` (Svelte UI).
 */

import {
	attachSqliteReadonlyPersistence,
	attachSync,
	findEpicenterDir,
	hashClientId,
	persistencePath,
	toWsUrl,
} from '@epicenter/workspace';
import { openFuji as openFujiDoc } from './index.js';

const SERVER_URL = 'https://api.epicenter.so';

function resolveDir(): string {
	try {
		return findEpicenterDir();
	} catch {
		return process.cwd();
	}
}

export function openFuji({
	getToken,
	absDir,
	clientID = hashClientId(Bun.main),
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
}) {
	const resolvedDir = absDir ?? resolveDir();

	const doc = openFujiDoc({ clientID });

	const filePath = persistencePath(resolvedDir, doc.ydoc.guid);
	const persistence = attachSqliteReadonlyPersistence(doc.ydoc, { filePath });

	// `whenReady` swallows `MissingFile` (no daemon has written here yet:
	// fall through to cold cloud sync) and re-throws every other error.
	// `defineErrors` tags variants with `.name`; matching on it avoids
	// racing the attachment's own existence check with `Bun.file().exists()`.
	const whenReady = persistence.whenLoaded.catch((err: unknown) => {
		if ((err as { name?: string } | null)?.name !== 'MissingFile') throw err;
	});

	const sync = attachSync(doc, {
		url: toWsUrl(`${SERVER_URL}/workspaces/${doc.ydoc.guid}`),
		waitFor: whenReady,
		getToken,
	});

	return {
		...doc,
		persistence,
		sync,
		whenReady,
	};
}
