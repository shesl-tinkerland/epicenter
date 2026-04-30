/**
 * Script-side factory for the Fuji workspace.
 *
 * Short-lived peers (one-shot CLI scripts, migrations, vault tools) read the
 * daemon's yjs file `{ readonly: true }` for warm hydrate, then run their
 * own cloud-sync attachment. Their writes flow through cloud; the daemon
 * picks them up via its own `attachSync` and writes to disk.
 *
 * No IPC. No coordination. The yjs read races nothing because scripts
 * never write to that file.
 *
 * Pairs with `daemon.ts` (long-lived materializer worker that owns the
 * yjs file) and `browser.ts` (Svelte UI).
 */

import {
	attachSqliteReadonlyPersistence,
	attachSync,
	findEpicenterDir,
	hashClientId,
	toWsUrl,
	yjsPath,
} from '@epicenter/workspace';
import { openFuji as openFujiDoc } from './index.js';

const SERVER_URL = 'https://api.epicenter.so';

export async function openFuji({
	getToken,
	absDir = findEpicenterDir(),
	clientID = hashClientId(Bun.main),
	webSocketImpl,
}: {
	getToken: () => string | null | Promise<string | null>;
	/**
	 * Project root. Defaults to the nearest ancestor of `process.cwd()`
	 * containing `epicenter.config.ts` or `.epicenter/`. Throws via
	 * `findEpicenterDir` if no such ancestor exists; pass an explicit
	 * `absDir` (e.g., `process.cwd()`) to opt out.
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
	const doc = openFujiDoc({ clientID });

	const persistence = attachSqliteReadonlyPersistence(doc.ydoc, {
		filePath: yjsPath(absDir, doc.ydoc.guid),
	});

	const sync = attachSync(doc, {
		url: toWsUrl(`${SERVER_URL}/workspaces/${doc.ydoc.guid}`),
		waitFor: persistence.whenLoaded,
		getToken,
		webSocketImpl,
	});

	// Await hydrate inside the factory: callers get a fully-hydrated handle
	// without remembering to await `whenReady`. The first WS handshake still
	// gates on the same promise via `waitFor`, so the cloud handshake is
	// delta-only when the file existed.
	await persistence.whenLoaded;

	return {
		...doc,
		persistence,
		sync,
	};
}
