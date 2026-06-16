/**
 * Resolve a daemon's durable node identity for one Epicenter root.
 *
 * A node id is the install-stable identity the relay routes presence and peer
 * dispatch by (see `document/node-id.ts`). The daemon's storage scope is its
 * Epicenter root's `.epicenter/` dir: the id is generated once and persisted to
 * `.epicenter/node.json`, so a restart reuses it, two folders on one machine
 * get distinct ids (distinct dirs), and two machines never collide (the id is
 * random, never derived from the root path or the mount name).
 *
 * `.epicenter/` is gitignored, so the id is machine-local. Vendoring or cloning
 * an app folder yields a fresh node on first run, which is the correct
 * identity for a new replica of the same app corpus.
 *
 * This reuses the one node-id mechanism (`createNodeId`) behind a
 * JSON-file-backed `SimpleStorage`, so the daemon shares its generate-once /
 * persist semantics with the browser and extension instead of inventing a
 * second scheme.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
	createNodeId,
	type NodeId,
	type SimpleStorage,
} from '../document/node-id.js';

/** `.epicenter/node.json`: the daemon's machine-local identity file. */
function nodeStatePath(epicenterRoot: string): string {
	return join(epicenterRoot, '.epicenter', 'node.json');
}

/**
 * `SimpleStorage` backed by a JSON object file. A missing or unparseable file
 * reads as empty (so a corrupt file self-heals into a fresh value on the next
 * write); writes create the parent dir and persist with owner-only mode.
 */
function createJsonFileStorage(filePath: string): SimpleStorage {
	function read(): Record<string, unknown> {
		if (!existsSync(filePath)) return {};
		try {
			const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
			return parsed !== null && typeof parsed === 'object'
				? (parsed as Record<string, unknown>)
				: {};
		} catch {
			return {};
		}
	}
	return {
		getItem(key) {
			const value = read()[key];
			return typeof value === 'string' ? value : null;
		},
		setItem(key, value) {
			mkdirSync(dirname(filePath), { recursive: true });
			const next = { ...read(), [key]: value };
			writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, {
				mode: 0o600,
			});
		},
	};
}

/**
 * Read or lazily generate the daemon's node id for an Epicenter root,
 * persisting it under `.epicenter/node.json`. Idempotent across restarts.
 */
export function resolveDaemonNodeId(epicenterRoot: string): NodeId {
	return createNodeId({
		storage: createJsonFileStorage(nodeStatePath(epicenterRoot)),
	});
}
