/**
 * Transcript demo: drive the real `local-books` CLI through the spec's slice 1-3
 * checkpoints against the mock QuickBooks server, running the literal goal
 * commands (including `sqlite3 books.db ...`). Not a unit test.
 *
 *   bun run test/demo-e2e.ts
 */
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeInvoice, startMockQbServer } from './mock-qb-server.ts';

const BIN = join(import.meta.dir, '../src/bin.ts');
const DATA_DIR = '/tmp/local-books-demo';
rmSync(DATA_DIR, { recursive: true, force: true });

async function sh(
	cmd: string[],
	env: Record<string, string> = {},
): Promise<string> {
	const proc = Bun.spawn(cmd, {
		env: { ...process.env, ...env },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [out, err] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	return (out + err).trimEnd();
}

function banner(label: string): void {
	console.log(`\n\x1b[1m━━ ${label} ━━\x1b[0m`);
}

const server = startMockQbServer();
const realmId = server.realmId;
const keyringFile = join(DATA_DIR, 'keyring.json');
const dbFile = join(DATA_DIR, realmId, 'books.db');

const env = {
	LOCAL_BOOKS_DIR: DATA_DIR,
	LOCAL_BOOKS_KEYRING_FILE: keyringFile,
	LOCAL_BOOKS_QB_API_BASE: server.apiBase,
	LOCAL_BOOKS_QB_TOKEN_URL: server.tokenUrl,
	LOCAL_BOOKS_QB_ENV: 'sandbox',
};
const cli = (...args: string[]) =>
	sh([process.execPath, BIN, ...args, '--realm', realmId], env);
const sqlite = (sql: string) => sh(['sqlite3', dbFile, sql]);

// Seed a keyring token (good for an hour) so we can run sync/status without the
// interactive browser hop. The mock accepts any bearer token.
async function main() {
	const { mkdirSync } = await import('node:fs');
	mkdirSync(DATA_DIR, { recursive: true });
	const now = Date.now();
	writeFileSync(
		keyringFile,
		JSON.stringify({
			[realmId]: JSON.stringify({
				realmId,
				environment: 'sandbox',
				accessToken: 'demo-access',
				refreshToken: 'demo-refresh',
				accessTokenExpiresAt: new Date(now + 3600 * 1000).toISOString(),
				refreshTokenExpiresAt: new Date(now + 8726400 * 1000).toISOString(),
				obtainedAt: new Date(now).toISOString(),
			}),
		}),
	);

	server.put('Invoice', makeInvoice('1001'));
	server.put('Invoice', makeInvoice('1002'));

	banner('Checkpoint 1 — status shows a valid, non-expired token');
	console.log(await cli('status'));

	banner('Checkpoint 2 — local-books sync --entity Invoice --full');
	console.log(await cli('sync', '--entity', 'Invoice', '--full'));
	console.log(
		'\n$ sqlite3 books.db "SELECT count(*), min(json_valid(raw)) FROM invoices"',
	);
	console.log(
		await sqlite('SELECT count(*), min(json_valid(raw)) FROM invoices'),
	);
	console.log(
		'\n$ sqlite3 books.db "SELECT entity, cdc_cursor FROM _sync_state"',
	);
	const cursorBefore = await sqlite(
		'SELECT entity, cdc_cursor FROM _sync_state',
	);
	console.log(cursorBefore);

	// Mutate the QuickBooks source after the full pull.
	await Bun.sleep(40);
	server.put('Invoice', makeInvoice('1002', { TotalAmt: 777 })); // update
	server.put('Invoice', makeInvoice('1003')); // new
	server.remove('Invoice', '1001'); // delete

	banner('Checkpoint 3 — second local-books sync (no --full) runs INCREMENTAL');
	console.log(await cli('sync', '--entity', 'Invoice'));
	console.log(
		'\n$ sqlite3 books.db "SELECT entity, cdc_cursor FROM _sync_state"  (cursor AFTER)',
	);
	console.log(await sqlite('SELECT entity, cdc_cursor FROM _sync_state'));
	console.log(
		'\n$ sqlite3 books.db "SELECT count(*) total, sum(deleted) soft_deleted FROM invoices"',
	);
	console.log(
		await sqlite(
			'SELECT count(*) AS total, sum(deleted) AS soft_deleted FROM invoices',
		),
	);
	console.log(
		'\n$ sqlite3 books.db "SELECT id, total_amt, deleted FROM invoices ORDER BY id"',
	);
	console.log(
		await sqlite('SELECT id, total_amt, deleted FROM invoices ORDER BY id'),
	);

	banner('No full re-pull: mock endpoint hit counts');
	console.log(`query endpoint hits (full pulls): ${server.hits.query}`);
	console.log(`cdc endpoint hits (incremental):  ${server.hits.cdc}`);

	banner('Final status');
	console.log(await cli('status'));

	server.stop();
}

await main();
