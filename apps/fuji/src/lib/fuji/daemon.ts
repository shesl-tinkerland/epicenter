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
	attachYjsLog,
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
	attachMarkdown,
	slugFilename,
} from '@epicenter/workspace/document/attach-markdown';
import { attachSqlite } from '@epicenter/workspace/document/attach-sqlite';
import { openFuji as openFujiDoc } from './core.js';

export function openFuji({
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
	 * via `workspace.sync.peer(deviceId)`. Mint via `getOrCreateDeviceId()` or
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

	// `attachYjsLog` constructs synchronously (mkdirSync + open + replay).
	// By the time this line returns, the Y.Doc is fully hydrated, so the
	// downstream attachments need no `waitFor` gate.
	const persistence = attachYjsLog(doc.ydoc, {
		filePath: yjsPath(projectDir, doc.ydoc.guid),
	});

	const sync = attachSync(doc, {
		url: toWsUrl(`${apiUrl}/workspaces/${doc.ydoc.guid}`),
		device,
		getToken,
		webSocketImpl,
	});

	const sqlite = attachSqlite(doc.ydoc, {
		filePath: sqlitePath(projectDir, doc.ydoc.guid),
	}).table(doc.tables.entries);

	const markdown = attachMarkdown(doc.ydoc, {
		dir: markdownPath(projectDir, doc.ydoc.guid),
	}).table(doc.tables.entries, { filename: slugFilename('title') });

	return {
		...doc,
		persistence,
		sync,
		sqlite,
		markdown,
	};
}
