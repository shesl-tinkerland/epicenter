/**
 * Read-only consumer for the Fuji example vault.
 *
 * Demonstrates the script-side factory: a one-shot peer that warm-hydrates
 * from the daemon's persistence file and runs its own cloud-sync attachment
 * for any rows the daemon has not yet flushed.
 *
 * Two modes, both supported by the same script:
 *
 *   Mode A (warm path): with `epicenter serve -C vault/fuji-example` running,
 *   the daemon owns the persistence file. `whenReady` resolves quickly
 *   because the readonly persistence replays the file's update log into
 *   the local Y.Doc; cloud sync then exchanges only a state-vector delta.
 *
 *   Mode B (cold path): with no daemon running, the persistence file may
 *   not exist. `attachSqliteReadonlyPersistence` rejects with `MissingFile`,
 *   the factory swallows it, and `attachSync` carries the full document
 *   over a fresh cloud WS. Entries print after a short sync delay.
 */

import { openFuji } from '@epicenter/fuji/script';
import { createSessionStore } from '@epicenter/cli';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';

const SERVER_URL = process.env.EPICENTER_SERVER ?? EPICENTER_API_URL;

const sessions = createSessionStore();

await using fuji = await openFuji({
	getToken: async () =>
		(await sessions.load(SERVER_URL))?.accessToken ?? null,
});

// Mode B (cold path) only: give cloud sync a brief window to deliver the
// initial document if there is no daemon-written persistence file. Mode A
// returns instantly because the factory already awaited the warm replay.
await Promise.race([
	fuji.sync.whenConnected,
	new Promise((resolve) => setTimeout(resolve, 2_000)),
]);

const rows = fuji.tables.entries.getAllValid();
console.log(`fuji.tables.entries: ${rows.length} row(s)`);
for (const row of rows) {
	console.log(`  ${row.id}\t${row.title}`);
}
