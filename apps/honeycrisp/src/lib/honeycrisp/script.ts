/**
 * Script-side factory for the Honeycrisp workspace.
 *
 * Short-lived peers (one-shot CLI scripts, migrations, vault tools) read the
 * daemon's persistence file `{ readonly: true }` for warm hydrate, then run
 * their own cloud-sync attachment.
 *
 * Pairs with `daemon.ts` and `browser.ts`.
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
import { openHoneycrisp as openHoneycrispDoc } from './index.js';

const SERVER_URL = 'https://api.epicenter.so';

function resolveDir(): string {
	try {
		return findEpicenterDir();
	} catch {
		return process.cwd();
	}
}

export async function openHoneycrisp({
	getToken,
	absDir,
	clientID = hashClientId(Bun.main),
	webSocketImpl,
}: {
	getToken: () => string | null | Promise<string | null>;
	absDir?: string;
	clientID?: number;
	webSocketImpl?: typeof WebSocket;
}) {
	const resolvedDir = absDir ?? resolveDir();

	const doc = openHoneycrispDoc({ clientID });

	const filePath = persistencePath(resolvedDir, doc.ydoc.guid);
	const persistence = attachSqliteReadonlyPersistence(doc.ydoc, { filePath });

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
