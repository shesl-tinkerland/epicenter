import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { parseInterval } from '../src/cli.ts';
import type { AppConfig } from '../src/config.ts';
import { openBooksDb } from '../src/db.ts';
import { entityDef } from '../src/entities.ts';
import { createMemoryKeyring } from '../src/keyring.ts';
import { createQbClient } from '../src/qb-client.ts';
import { runSyncLoop, syncEntity } from '../src/sync.ts';
import {
	createTokenManager,
	loadToken,
	storeToken,
} from '../src/token-manager.ts';
import { type TokenSet, tokenSetFromGrant } from '../src/tokens.ts';
import { makeConfig, sampleGrant, tempDir } from './helpers.ts';
import { makeInvoice, startMockQbServer } from './mock-qb-server.ts';

/** Wire the real engine (db + client + token manager + sync) to the mock. */
function setup(configOver: Partial<AppConfig> = {}) {
	let clock = Date.parse('2026-06-21T00:00:00.000Z');
	const now = () => clock;
	const advance = (ms = 5000) => {
		clock += ms;
	};

	const server = startMockQbServer({ now });
	const config = makeConfig({
		apiBase: server.apiBase,
		tokenUrl: server.tokenUrl,
		realmOverride: server.realmId,
		entities: ['Invoice'],
		...configOver,
	});
	const keyring = createMemoryKeyring();
	const token = tokenSetFromGrant(sampleGrant, {
		realmId: server.realmId,
		environment: 'sandbox',
		now: clock,
	}).data as TokenSet;
	const tokens = createTokenManager({ config, keyring, token, deps: { now } });
	const client = createQbClient({
		config,
		realmId: server.realmId,
		tokens,
		sleep: async () => {},
	});
	const tmp = tempDir();
	const db = openBooksDb(join(tmp.dir, 'books.db'));

	const teardown = () => {
		db.close();
		server.stop();
		tmp.cleanup();
	};
	return {
		server,
		config,
		db,
		deps: { db, client, config, now },
		advance,
		teardown,
	};
}

const one = <T>(db: ReturnType<typeof openBooksDb>, sql: string): T =>
	db.raw.query(sql).get() as T;

test('full pull seeds the mirror with valid JSON and a populated cursor', async () => {
	const ctx = setup();
	const def = entityDef('Invoice');
	ctx.server.put('Invoice', makeInvoice('1'));
	ctx.server.put('Invoice', makeInvoice('2'));
	ctx.server.put('Invoice', makeInvoice('3'));

	const { data, error } = await syncEntity(ctx.deps, def, { forceFull: true });
	expect(error).toBeNull();
	expect(data?.mode).toBe('FULL');
	expect(data?.upserted).toBe(3);
	expect(data?.deleted).toBe(0);

	// The literal goal check: rows present, raw is valid JSON.
	const counts = one<{ n: number; v: number }>(
		ctx.db,
		'SELECT count(*) AS n, min(json_valid(raw)) AS v FROM invoices',
	);
	expect(counts.n).toBe(3);
	expect(counts.v).toBe(1);

	// _sync_state cursor populated, and equal to the full pull's cursor.
	const state = ctx.db.readSyncState('Invoice');
	expect(state?.cdcCursor).toBe(data!.cursorAfter);
	expect(state?.lastFullPullAt).toBe(data!.cursorAfter);

	ctx.teardown();
});

test('incremental upserts only changes, soft-deletes, advances the cursor, and never re-pulls', async () => {
	const ctx = setup();
	const def = entityDef('Invoice');
	ctx.server.put('Invoice', makeInvoice('1'));
	ctx.server.put('Invoice', makeInvoice('2'));
	ctx.server.put('Invoice', makeInvoice('3'));

	const full = await syncEntity(ctx.deps, def, { forceFull: true });
	const cursorBefore = full.data!.cursorAfter;

	// Mutate the source after the full pull: update 2, add 4, delete 3.
	ctx.advance();
	ctx.server.put('Invoice', makeInvoice('2', { TotalAmt: 999 }));
	ctx.server.put('Invoice', makeInvoice('4'));
	ctx.server.remove('Invoice', '3');

	const inc = await syncEntity(ctx.deps, def, { forceFull: false });
	expect(inc.error).toBeNull();
	expect(inc.data?.mode).toBe('INCREMENTAL');
	expect(inc.data?.upserted).toBe(2); // invoice 2 (updated) + invoice 4 (new)
	expect(inc.data?.deleted).toBe(1); // invoice 3

	// Cursor advanced, not reset.
	expect(inc.data?.cursorBefore).toBe(cursorBefore);
	expect(Date.parse(inc.data!.cursorAfter)).toBeGreaterThan(
		Date.parse(cursorBefore),
	);
	expect(ctx.db.readSyncState('Invoice')?.cdcCursor).toBe(
		inc.data!.cursorAfter,
	);

	// No full re-pull: exactly one query (the full) and one cdc (the incremental).
	expect(ctx.server.hits.query).toBe(1);
	expect(ctx.server.hits.cdc).toBe(1);

	// Mirror reflects the changes.
	expect(
		one<{ n: number }>(ctx.db, 'SELECT count(*) AS n FROM invoices').n,
	).toBe(4);
	expect(
		one<{ n: number }>(
			ctx.db,
			'SELECT count(*) AS n FROM invoices WHERE deleted=1',
		).n,
	).toBe(1);

	// Updated row reflected in both the extracted column and the blob.
	const inv2 = one<{ total_amt: number; raw: string }>(
		ctx.db,
		"SELECT total_amt, raw FROM invoices WHERE id='2'",
	);
	expect(inv2.total_amt).toBe(999);
	expect(JSON.parse(inv2.raw).TotalAmt).toBe(999);

	// Soft-delete preserves the blob (not just the delete stub).
	const inv3 = one<{ deleted: number; doc_number: string; raw: string }>(
		ctx.db,
		"SELECT deleted, doc_number, raw FROM invoices WHERE id='3'",
	);
	expect(inv3.deleted).toBe(1);
	expect(inv3.doc_number).toBe('INV-3');
	expect(JSON.parse(inv3.raw).DocNumber).toBe('INV-3');

	ctx.teardown();
});

test('a second incremental with no source changes is a clean no-op that still advances the cursor', async () => {
	const ctx = setup();
	const def = entityDef('Invoice');
	ctx.server.put('Invoice', makeInvoice('1'));
	await syncEntity(ctx.deps, def, { forceFull: true });

	ctx.advance();
	const inc = await syncEntity(ctx.deps, def, { forceFull: false });
	expect(inc.data?.mode).toBe('INCREMENTAL');
	expect(inc.data?.upserted).toBe(0);
	expect(inc.data?.deleted).toBe(0);
	expect(Date.parse(inc.data!.cursorAfter)).toBeGreaterThan(
		Date.parse(inc.data!.cursorBefore!),
	);

	ctx.teardown();
});

test('a throttled (429) request is retried and the pull still completes', async () => {
	const ctx = setup();
	const def = entityDef('Invoice');
	ctx.server.put('Invoice', makeInvoice('1'));
	ctx.server.fail429(2); // first two data requests are throttled

	const { data, error } = await syncEntity(ctx.deps, def, { forceFull: true });
	expect(error).toBeNull();
	expect(data?.upserted).toBe(1);
	// Throttled responses are not counted as successful query hits.
	expect(ctx.server.hits.query).toBe(1);

	ctx.teardown();
});

test('a 401 triggers a transparent refresh, retries, and persists the new token', async () => {
	const clock = Date.parse('2026-06-21T00:00:00.000Z');
	const now = () => clock;
	const server = startMockQbServer({ now });
	const config = makeConfig({
		apiBase: server.apiBase,
		tokenUrl: server.tokenUrl,
		realmOverride: server.realmId,
	});
	const keyring = createMemoryKeyring();
	const stale: TokenSet = {
		realmId: server.realmId,
		environment: 'sandbox',
		accessToken: 'stale-access',
		refreshToken: 'valid-refresh',
		accessTokenExpiresAt: new Date(clock + 3600 * 1000).toISOString(),
		refreshTokenExpiresAt: new Date(clock + 8726400 * 1000).toISOString(),
		obtainedAt: new Date(clock).toISOString(),
	};
	await storeToken(keyring, stale);
	server.rejectAccessToken('stale-access');

	const tokens = createTokenManager({
		config,
		keyring,
		token: stale,
		deps: { now },
	});
	const client = createQbClient({
		config,
		realmId: server.realmId,
		tokens,
		sleep: async () => {},
	});
	server.put('Invoice', makeInvoice('1'));

	const { data, error } = await client.queryAll('Invoice');
	expect(error).toBeNull();
	expect(data?.length).toBe(1);
	expect(server.hits.token).toBe(1); // exactly one refresh
	expect(tokens.current().accessToken).not.toBe('stale-access');

	const persisted = await loadToken(keyring, server.realmId);
	expect(persisted?.accessToken).toBe(tokens.current().accessToken);

	server.stop();
});

test('parseInterval understands s / m / h and rejects junk', () => {
	expect(parseInterval('30s')).toBe(30_000);
	expect(parseInterval('30m')).toBe(30 * 60_000);
	expect(parseInterval('2h')).toBe(2 * 3_600_000);
	expect(parseInterval('45')).toBe(45 * 60_000); // a bare number means minutes
	expect(() => parseInterval('soon')).toThrow();
});

test('runSyncLoop: full first pass, incremental after, stops on abort', async () => {
	const ctx = setup();
	ctx.server.put('Invoice', makeInvoice('1'));

	const controller = new AbortController();
	await runSyncLoop(ctx.deps, {
		forceFull: true,
		entities: ['Invoice'],
		intervalMs: 1,
		signal: controller.signal,
		onPass: (_outcome, pass) => {
			ctx.advance(); // move the clock forward between passes
			if (pass >= 2) controller.abort(); // stop after the 2nd pass
		},
	});

	// Pass 1 was FULL (one query), pass 2 was INCREMENTAL (one cdc): no re-pull.
	expect(ctx.server.hits.query).toBe(1);
	expect(ctx.server.hits.cdc).toBe(1);

	ctx.teardown();
});
