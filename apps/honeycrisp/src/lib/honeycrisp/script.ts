/**
 * Script-side factory for the Honeycrisp workspace.
 *
 * Short-lived peers (one-shot CLI scripts, migrations, vault tools) read the
 * daemon's yjs file `{ readonly: true }` for warm hydrate, then run their
 * own cloud-sync attachment.
 *
 * Pairs with `daemon.ts` and `browser.ts`.
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
import { openHoneycrisp as openHoneycrispDoc } from './index.js';

export async function openHoneycrisp({
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
	 * `absDir` (e.g., `process.cwd() as ProjectDir`) to opt out.
	 */
	absDir?: ProjectDir;
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
	const doc = openHoneycrispDoc({ clientID });

	const persistence = attachSqliteReadonlyPersistence(doc.ydoc, {
		filePath: yjsPath(absDir, doc.ydoc.guid),
	});

	const sync = attachSync(doc, {
		url: toWsUrl(`${EPICENTER_API_URL}/workspaces/${doc.ydoc.guid}`),
		waitFor: persistence.whenLoaded,
		getToken,
		webSocketImpl,
	});

	await persistence.whenLoaded;

	return {
		...doc,
		persistence,
		sync,
	};
}
