/**
 * Daemon-side factory for the Fuji workspace.
 *
 * Wires the long-lived materializer worker: cloud sync over WebSocket plus
 * sole-writer SQLite persistence plus SQLite + markdown materializer
 * projections. Constructed once per `epicenter serve` process.
 *
 * Pairs with `script.ts` (short-lived peers that read this daemon's
 * persistence file and sync via cloud) and `browser.ts` (Svelte UI).
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import {
	attachSqlitePersistence,
	attachSync,
	type DeviceDescriptor,
	markdownPath,
	persistencePath,
	sqlitePath,
	toWsUrl,
} from '@epicenter/workspace';
import { attachMarkdownMaterializer } from '@epicenter/workspace/document/materializer/markdown';
import { attachSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';
import { openFuji as openFujiDoc } from './index.js';

const SERVER_URL = 'https://api.epicenter.so';

export function openFuji({
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
	const doc = openFujiDoc();

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

	const sqliteFile = sqlitePath(absDir, doc.ydoc.guid);
	// `attachSqliteMaterializer` takes a Database, not a path, so it can't
	// create its own parent dir. `attachSqlitePersistence` mkdirs its own.
	mkdirSync(path.dirname(sqliteFile), { recursive: true });
	const sqlite = attachSqliteMaterializer(doc.ydoc, {
		db: new Database(sqliteFile),
		waitFor: persistence.whenLoaded,
	}).table(doc.tables.entries);

	const markdown = attachMarkdownMaterializer(doc.ydoc, {
		dir: markdownPath(absDir, doc.ydoc.guid),
		waitFor: persistence.whenLoaded,
	});

	return {
		...doc,
		persistence,
		sync,
		sqlite,
		markdown,
		/**
		 * Resolves once the daemon's persistence file has replayed into the
		 * Y.Doc: the durable state is in memory and writes are safe. Does
		 * NOT gate the materializers' initial flush (they `waitFor` the same
		 * signal but their first row writes happen after this resolves) or
		 * the cloud WS handshake (offline-tolerant by design). Compose with
		 * `sync.whenConnected` if you need "fully online before proceeding."
		 */
		whenReady: persistence.whenLoaded,
	};
}
