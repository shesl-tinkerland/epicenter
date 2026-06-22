import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './helpers.ts';
import { makeInvoice, startMockQbServer } from './mock-qb-server.ts';

const BIN = join(import.meta.dir, '../src/bin.ts');

/** Seed a file-keyring token good for an hour (mock accepts any bearer). */
function seedKeyring(file: string, realmId: string): void {
	const now = Date.now();
	const token = {
		realmId,
		environment: 'sandbox',
		accessToken: 'seed-access',
		refreshToken: 'seed-refresh',
		accessTokenExpiresAt: new Date(now + 3600 * 1000).toISOString(),
		refreshTokenExpiresAt: new Date(now + 8726400 * 1000).toISOString(),
		obtainedAt: new Date(now).toISOString(),
	};
	writeFileSync(
		file,
		JSON.stringify({ [realmId]: JSON.stringify(token) }, null, 2),
	);
}

async function runCli(args: string[], env: Record<string, string>) {
	const proc = Bun.spawn([process.execPath, BIN, ...args], {
		env: { ...process.env, ...env },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

test('CLI: `sync --full` then `sync` runs incremental, advances the cursor, no re-pull', async () => {
	const server = startMockQbServer();
	const tmp = tempDir();
	const keyringFile = join(tmp.dir, 'keyring.json');
	seedKeyring(keyringFile, server.realmId);
	const env = {
		LOCAL_BOOKS_DIR: tmp.dir,
		LOCAL_BOOKS_KEYRING_FILE: keyringFile,
		LOCAL_BOOKS_QB_API_BASE: server.apiBase,
		LOCAL_BOOKS_QB_TOKEN_URL: server.tokenUrl,
		LOCAL_BOOKS_QB_ENV: 'sandbox',
	};
	const dbFile = join(tmp.dir, server.realmId, 'books.db');

	server.put('Invoice', makeInvoice('1'));
	server.put('Invoice', makeInvoice('2'));

	// Checkpoint 2: full pull.
	const full = await runCli(
		['sync', '--entity', 'Invoice', '--full', '--realm', server.realmId],
		env,
	);
	expect(full.exitCode).toBe(0);
	expect(full.stdout).toContain('FULL');

	const read1 = new Database(dbFile, { readonly: true });
	const counts = read1
		.query('SELECT count(*) AS n, min(json_valid(raw)) AS v FROM invoices')
		.get() as { n: number; v: number };
	const cursor1 = (
		read1
			.query("SELECT cdc_cursor FROM _sync_state WHERE entity='Invoice'")
			.get() as {
			cdc_cursor: string;
		}
	).cdc_cursor;
	read1.close();
	expect(counts.n).toBe(2);
	expect(counts.v).toBe(1);
	expect(cursor1).toBeTruthy();

	// Mutate the source after the full pull (small gap so timestamps clear the cursor).
	await Bun.sleep(30);
	server.put('Invoice', makeInvoice('2', { TotalAmt: 555 }));
	server.put('Invoice', makeInvoice('3'));

	// Checkpoint 3: incremental.
	const inc = await runCli(
		['sync', '--entity', 'Invoice', '--realm', server.realmId],
		env,
	);
	expect(inc.exitCode).toBe(0);
	expect(inc.stdout).toContain('INCREMENTAL');

	const read2 = new Database(dbFile, { readonly: true });
	const after = read2.query('SELECT count(*) AS n FROM invoices').get() as {
		n: number;
	};
	const cursor2 = (
		read2
			.query("SELECT cdc_cursor FROM _sync_state WHERE entity='Invoice'")
			.get() as {
			cdc_cursor: string;
		}
	).cdc_cursor;
	read2.close();
	expect(after.n).toBe(3);
	expect(Date.parse(cursor2)).toBeGreaterThan(Date.parse(cursor1));

	// The proof that incremental did NOT re-pull: one query (full) + one cdc (incremental).
	expect(server.hits.query).toBe(1);
	expect(server.hits.cdc).toBe(1);

	server.stop();
	tmp.cleanup();
});
