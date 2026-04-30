/**
 * Script-side factory for the Opensidian workspace.
 *
 * Short-lived peers (one-shot CLI scripts, migrations, vault tools) read the
 * daemon's yjs file `{ readonly: true }` for warm hydrate, then run their
 * own cloud-sync attachment.
 *
 * Pairs with `daemon.ts` and `browser.ts`.
 */

import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachYjsLogReader,
	attachSync,
	findEpicenterDir,
	hashClientId,
	type ProjectDir,
	toWsUrl,
	yjsPath,
	type WebSocketImpl,
} from '@epicenter/workspace';
import { openOpensidian as openOpensidianDoc } from './core.js';

export function openOpensidian({
	getToken,
	projectDir = findEpicenterDir(),
	clientID = hashClientId(Bun.main),
	apiUrl = EPICENTER_API_URL,
	webSocketImpl,
}: {
	getToken: () => Promise<string | null>;
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
	 * Epicenter API base URL. Defaults to `EPICENTER_API_URL` (production).
	 * Override for self-hosted instances, staging deployments, or
	 * integration tests routing to a local fake.
	 */
	apiUrl?: string;
	/**
	 * WebSocket constructor for `attachSync`. Tests pass a stub to avoid
	 * dialing real servers; production omits it.
	 */
	webSocketImpl?: WebSocketImpl;
}) {
	const doc = openOpensidianDoc({ clientID });

	// `attachYjsLogReader` constructs synchronously: existsSync + open +
	// replay all run on the calling tick. The Y.Doc is fully hydrated by
	// the time this line returns, so `attachSync` needs no `waitFor`.
	const persistence = attachYjsLogReader(doc.ydoc, {
		filePath: yjsPath(projectDir, doc.ydoc.guid),
	});

	const sync = attachSync(doc, {
		url: toWsUrl(`${apiUrl}/workspaces/${doc.ydoc.guid}`),
		getToken,
		webSocketImpl,
	});

	return {
		...doc,
		persistence,
		sync,
	};
}
