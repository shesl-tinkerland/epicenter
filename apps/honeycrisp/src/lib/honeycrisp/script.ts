/**
 * Script-side factory for the Honeycrisp workspace.
 *
 * Short-lived peers (one-shot CLI scripts, migrations, vault tools) read the
 * daemon's yjs file `{ readonly: true }` for warm hydrate, then run their
 * own cloud-sync attachment.
 *
 * Pairs with `daemon.ts` and `browser.ts`.
 */

import {
	attachSqliteReadonlyPersistence,
	attachSync,
	findEpicenterDir,
	hashClientId,
	toWsUrl,
	yjsPath,
} from '@epicenter/workspace';
import { openHoneycrisp as openHoneycrispDoc } from './index.js';

const SERVER_URL = 'https://api.epicenter.so';

export async function openHoneycrisp({
	getToken,
	absDir = findEpicenterDir(),
	clientID = hashClientId(Bun.main),
	webSocketImpl,
}: {
	getToken: () => string | null | Promise<string | null>;
	absDir?: string;
	clientID?: number;
	webSocketImpl?: typeof WebSocket;
}) {
	const doc = openHoneycrispDoc({ clientID });

	const persistence = attachSqliteReadonlyPersistence(doc.ydoc, {
		filePath: yjsPath(absDir, doc.ydoc.guid),
	});

	const sync = attachSync(doc, {
		url: toWsUrl(`${SERVER_URL}/workspaces/${doc.ydoc.guid}`),
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
