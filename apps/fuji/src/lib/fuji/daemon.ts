/**
 * Daemon-side factory for the Fuji workspace.
 *
 * Wires the long-lived materializer worker: cloud sync over WebSocket plus
 * sole-writer SQLite persistence (the yjs update log) plus SQLite +
 * markdown materializer projections. Constructed once per `epicenter
 * serve` process.
 *
 * Pairs with `script.ts` (short-lived peers that read this daemon's yjs
 * file and sync via cloud) and `browser.ts` (Svelte UI).
 */

import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachSqlitePersistence,
	attachSync,
	type DeviceDescriptor,
	markdownPath,
	type ProjectDir,
	sqlitePath,
	toWsUrl,
	yjsPath,
	type WebSocketImpl,
} from '@epicenter/workspace';
import {
	attachMarkdownMaterializer,
	slugFilename,
} from '@epicenter/workspace/document/materializer/markdown';
import { attachSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';
import { openFuji as openFujiDoc } from './core.js';

export async function openFuji({
	getToken,
	device,
	projectDir,
	apiUrl = EPICENTER_API_URL,
	webSocketImpl,
}: {
	getToken: () => string | null | Promise<string | null>;
	/**
	 * Required: a long-lived materializer worker should always show up in
	 * awareness so peers can see "the daemon is up" and can RPC-route to it
	 * via `peer(workspace, deviceId)`. Mint via `getOrCreateDeviceId()` or
	 * read from `~/.epicenter/deviceId`.
	 */
	device: DeviceDescriptor;
	/**
	 * Project root (where `epicenter.config.ts` lives). Required: the daemon
	 * is the sole writer of `<projectDir>/.epicenter/yjs/<guid>.db`, so there
	 * is no sane fallback. Mint via `findEpicenterDir()` at the call site
	 * to brand a discovered path as `ProjectDir`.
	 */
	projectDir: ProjectDir;
	/**
	 * Epicenter API base URL. Defaults to `EPICENTER_API_URL` (production).
	 * Override for self-hosted instances, staging deployments, or
	 * integration tests routing to a local fake.
	 */
	apiUrl?: string;
	/**
	 * WebSocket constructor for `attachSync`. Tests pass a stub to avoid
	 * dialing real servers; production omits it (defaults to
	 * `globalThis.WebSocket`).
	 */
	webSocketImpl?: WebSocketImpl;
}) {
	const doc = openFujiDoc();

	const persistence = attachSqlitePersistence(doc.ydoc, {
		filePath: yjsPath(projectDir, doc.ydoc.guid),
	});

	const sync = attachSync(doc, {
		url: toWsUrl(`${apiUrl}/workspaces/${doc.ydoc.guid}`),
		waitFor: persistence.whenLoaded,
		device,
		getToken,
		webSocketImpl,
	});

	const sqlite = attachSqliteMaterializer(doc.ydoc, {
		filePath: sqlitePath(projectDir, doc.ydoc.guid),
		waitFor: persistence.whenLoaded,
	}).table(doc.tables.entries);

	const markdown = attachMarkdownMaterializer(doc.ydoc, {
		dir: markdownPath(projectDir, doc.ydoc.guid),
		waitFor: persistence.whenLoaded,
	}).table(doc.tables.entries, { filename: slugFilename('title') });

	// Await hydration before returning so callers receive a fully-loaded
	// handle. Drop the `whenReady` field: the `await` here is the contract.
	await persistence.whenLoaded;

	return {
		...doc,
		persistence,
		sync,
		sqlite,
		markdown,
	};
}
