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

import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachSqliteReadonlyPersistence,
	attachSync,
	findEpicenterDir,
	hashClientId,
	type ProjectDir,
	toWsUrl,
	yjsPath,
	type WebSocketImpl,
} from '@epicenter/workspace';
import { openFuji as openFujiDoc } from './index.js';

export async function openFuji({
	getToken,
	projectDir = findEpicenterDir(),
	clientID = hashClientId(Bun.main),
	webSocketImpl,
}: {
	getToken: () => string | null | Promise<string | null>;
	/**
	 * Project root. Defaults to the nearest ancestor of `process.cwd()`
	 * containing `epicenter.config.ts` or `.epicenter/`. Throws via
	 * `findEpicenterDir` if no such ancestor exists; pass an explicit
	 * `projectDir` to opt out (callers minting one outside `findEpicenterDir`
	 * are responsible for the brand contract).
	 */
	projectDir?: ProjectDir;
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
	webSocketImpl?: WebSocketImpl;
}) {
	const doc = openFujiDoc({ clientID });

	const persistence = attachSqliteReadonlyPersistence(doc.ydoc, {
		filePath: yjsPath(projectDir, doc.ydoc.guid),
	});

	const sync = attachSync(doc, {
		url: toWsUrl(`${EPICENTER_API_URL}/workspaces/${doc.ydoc.guid}`),
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
