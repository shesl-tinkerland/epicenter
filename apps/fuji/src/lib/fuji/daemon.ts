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
	markdownPathFor,
	mirrorPathFor,
	persistencePath,
	toWsUrl,
} from '@epicenter/workspace';
import { attachMarkdownMaterializer } from '@epicenter/workspace/document/materializer/markdown';
import { attachSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';
import { openFuji as openFujiDoc } from './index.js';

const SERVER_URL = 'https://api.epicenter.so';

export function openFuji({
	authToken,
	device,
	absDir,
}: {
	authToken: string | (() => string | null | Promise<string | null>);
	device?: DeviceDescriptor;
	absDir: string;
}) {
	const doc = openFujiDoc();

	const persistence = attachSqlitePersistence(doc.ydoc, {
		filePath: persistencePath(absDir, doc.ydoc.guid),
	});

	const sync = attachSync(doc, {
		url: toWsUrl(`${SERVER_URL}/workspaces/${doc.ydoc.guid}`),
		waitFor: persistence.whenLoaded,
		device,
		getToken:
			typeof authToken === 'function' ? authToken : () => authToken,
	});

	const mirrorFile = mirrorPathFor(absDir, doc.ydoc.guid);
	// `attachSqliteMaterializer` takes a Database, not a path, so it can't
	// create its own parent dir. `attachSqlitePersistence` mkdirs its own.
	mkdirSync(path.dirname(mirrorFile), { recursive: true });
	const sqlite = attachSqliteMaterializer(doc.ydoc, {
		db: new Database(mirrorFile),
		waitFor: persistence.whenLoaded,
	}).table(doc.tables.entries);

	const markdown = attachMarkdownMaterializer(doc.ydoc, {
		dir: markdownPathFor(absDir, doc.ydoc.guid),
		waitFor: persistence.whenLoaded,
	});

	return {
		...doc,
		persistence,
		sync,
		sqlite,
		markdown,
		whenReady: persistence.whenLoaded,
	};
}
