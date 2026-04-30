/**
 * Daemon-side factory for the Opensidian workspace.
 *
 * Wires the long-lived materializer worker: cloud sync over WebSocket plus
 * sole-writer SQLite persistence. Constructed once per `epicenter serve`
 * process. SQLite/markdown materializer projections are intentionally not
 * wired here; they need per-file content docs (see
 * `playground/opensidian-e2e/epicenter.config.ts` for the full composition)
 * which a single one-line factory can't capture.
 *
 * Pairs with `script.ts` (short-lived peers that read this daemon's
 * persistence file and sync via cloud) and `browser.ts` (Svelte UI).
 */

import {
	attachSqlitePersistence,
	attachSync,
	type DeviceDescriptor,
	persistencePath,
	toWsUrl,
} from '@epicenter/workspace';
import { openOpensidian as openOpensidianDoc } from './index.js';

const SERVER_URL = 'https://api.epicenter.so';

export function openOpensidian({
	getToken,
	device,
	absDir,
	webSocketImpl,
}: {
	getToken: () => string | null | Promise<string | null>;
	device?: DeviceDescriptor;
	absDir: string;
	/**
	 * WebSocket constructor for `attachSync`. Tests pass a stub to avoid
	 * dialing real servers; production omits it (defaults to
	 * `globalThis.WebSocket`).
	 */
	webSocketImpl?: typeof WebSocket;
}) {
	const doc = openOpensidianDoc();

	const persistence = attachSqlitePersistence(doc.ydoc, {
		filePath: persistencePath(absDir, doc.ydoc.guid),
	});

	const sync = attachSync(doc, {
		url: toWsUrl(`${SERVER_URL}/workspaces/${doc.ydoc.guid}`),
		waitFor: persistence.whenLoaded,
		device,
		getToken,
		webSocketImpl,
	});

	return {
		...doc,
		persistence,
		sync,
		/**
		 * Resolves once the daemon's persistence file has replayed into the
		 * Y.Doc: the durable state is in memory and writes are safe. Does NOT
		 * gate the cloud WS handshake. Compose with `sync.whenConnected` for
		 * "fully online before proceeding."
		 */
		whenReady: persistence.whenLoaded,
	};
}
