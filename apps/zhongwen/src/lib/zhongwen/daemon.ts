/**
 * Daemon-side factory for the Zhongwen workspace.
 *
 * Wires the long-lived materializer worker: cloud sync over WebSocket plus
 * sole-writer SQLite persistence. Constructed once per `epicenter serve`
 * process. Materializer projections are not wired here; layer them on at
 * the consumer if needed.
 *
 * Pairs with `script.ts` and `browser.ts`.
 */

import {
	attachSqlitePersistence,
	attachSync,
	type DeviceDescriptor,
	persistencePath,
	toWsUrl,
} from '@epicenter/workspace';
import { openZhongwen as openZhongwenDoc } from './index.js';

const SERVER_URL = 'https://api.epicenter.so';

export function openZhongwen({
	getToken,
	device,
	absDir,
	webSocketImpl,
}: {
	getToken: () => string | null | Promise<string | null>;
	device?: DeviceDescriptor;
	absDir: string;
	webSocketImpl?: typeof WebSocket;
}) {
	const doc = openZhongwenDoc();

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
		whenReady: persistence.whenLoaded,
	};
}
