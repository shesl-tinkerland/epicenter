/**
 * `recategorize_expense` reached the way the client agent loop reaches it: as a
 * dispatched action resolved through `createDispatchToolCatalog`, driven against
 * a mock QuickBooks server and a seeded mirror. Proves the write-through path end
 * to end: read the SyncToken from the mirror -> sparse-update QuickBooks -> fold
 * the authoritative response back into the mirror. Also proves the safety
 * primitive: a stale SyncToken is rejected, never clobbered.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	createDispatchToolCatalog,
	type DispatchSurface,
} from '@epicenter/workspace/agent';
import { Ok } from 'wellcrafted/result';
import { makeConfig } from '../../test/helpers.ts';
import { makePurchase, startMockQbServer } from '../../test/mock-qb-server.ts';
import { openBooksDb } from '../db.ts';
import { entityDef } from '../entities.ts';
import { createFileKeyring } from '../keyring.ts';
import type { TokenSet } from '../tokens.ts';
import { createBooksAgentActions } from './books-actions.ts';
import { makeQbAccess } from './qb-access.ts';

/** No peers: a books action resolves in-process; dispatch is never reached. */
const LOCAL_ONLY: DispatchSurface = {
	peers: { list: () => [] },
	dispatch: () => Promise.resolve(Ok(null)),
};

const NOW = Date.parse('2026-02-01T00:00:00.000Z');
const now = () => NOW;

/**
 * Boot a mock company with one Purchase, seed its token + mirror, and return a
 * catalog wired to the write tool. `mirrorSyncToken` lets a test seed the mirror
 * with a stale token to exercise the 409 path.
 */
async function setup(
	opts: { mockSyncToken?: string; mirrorSyncToken?: string } = {},
) {
	const dir = mkdtempSync(join(tmpdir(), 'local-books-'));
	const mock = startMockQbServer({ now });
	mock.put(
		'Purchase',
		makePurchase('p1', { SyncToken: opts.mockSyncToken ?? '0' }),
	);

	const keyringFile = join(dir, 'keyring.json');
	const config = makeConfig({
		dataDir: dir,
		apiBase: mock.apiBase,
		tokenUrl: mock.tokenUrl,
		keyringFile,
		entities: ['Purchase'],
	});
	const keyring = createFileKeyring(keyringFile);
	const token: TokenSet = {
		realmId: mock.realmId,
		environment: 'sandbox',
		accessToken: 'access-seed',
		refreshToken: 'refresh-seed',
		accessTokenExpiresAt: new Date(NOW + 86_400_000).toISOString(),
		refreshTokenExpiresAt: new Date(NOW + 8_726_400_000).toISOString(),
		obtainedAt: new Date(NOW).toISOString(),
	};
	await keyring.set(mock.realmId, JSON.stringify(token));

	const path = join(dir, mock.realmId, 'books.db');
	const db = openBooksDb(path);
	db.upsertObjects(
		entityDef('Purchase'),
		[
			{
				id: 'p1',
				raw: JSON.stringify(
					makePurchase('p1', { SyncToken: opts.mirrorSyncToken ?? '0' }),
				),
				updatedAt: '2026-01-15T00:00:00.000Z',
			},
		],
		'2026-01-20T00:00:00.000Z',
	);
	db.close();

	const openQb = makeQbAccess({ config, realmId: mock.realmId, keyring, now });
	const catalog = createDispatchToolCatalog(LOCAL_ONLY, {
		localActions: createBooksAgentActions({ dbPath: path, openQb, now }),
	});
	return {
		mock,
		path,
		catalog,
		cleanup: () => {
			mock.stop();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

function recategorize(
	catalog: ReturnType<typeof createDispatchToolCatalog>,
	input: Record<string, string>,
) {
	return catalog.resolve(
		{ toolCallId: 't1', toolName: 'recategorize_expense', input },
		new AbortController().signal,
	);
}

function lineAccount(obj: Record<string, unknown>): string | undefined {
	const line = (obj.Line as Record<string, unknown>[] | undefined)?.[0];
	const detail = line?.AccountBasedExpenseLineDetail as
		| { AccountRef?: { value?: string } }
		| undefined;
	return detail?.AccountRef?.value;
}

describe('recategorize_expense as a dispatched action', () => {
	test('the catalog advertises it as a mutation (needs approval)', async () => {
		const { catalog, cleanup } = await setup();
		const def = catalog
			.definitions()
			.find((d) => d.name === 'recategorize_expense');
		expect(def?.kind).toBe('mutation');
		cleanup();
	});

	test('moves the expense line in QuickBooks and folds it into the mirror', async () => {
		const { mock, path, catalog, cleanup } = await setup();

		const outcome = await recategorize(catalog, {
			entity: 'Purchase',
			id: 'p1',
			account_id: '77',
			account_name: 'Cloud Infrastructure',
		});
		expect(outcome.isError).toBe(false);
		expect(mock.hits.update).toBe(1);

		// QuickBooks (the source of truth) now has the new category + a bumped token.
		const remote = mock.get('Purchase', 'p1');
		expect(remote && lineAccount(remote)).toBe('77');
		expect(remote?.SyncToken).toBe('1');

		// The mirror reflects the authoritative response (token '1', not the old '0').
		const db = openBooksDb(path);
		const row = db.raw
			.query<{ raw: string }, []>(`SELECT raw FROM purchases WHERE id = 'p1'`)
			.get();
		const mirrored = JSON.parse(row?.raw ?? '{}');
		expect(lineAccount(mirrored)).toBe('77');
		expect(mirrored.SyncToken).toBe('1');
		db.close();

		cleanup();
	});

	test('a stale SyncToken is rejected, leaving QuickBooks untouched', async () => {
		// Mirror thinks the token is '0'; QuickBooks has moved on to '5'.
		const { mock, catalog, cleanup } = await setup({
			mockSyncToken: '5',
			mirrorSyncToken: '0',
		});

		const outcome = await recategorize(catalog, {
			entity: 'Purchase',
			id: 'p1',
			account_id: '77',
		});
		expect(outcome.isError).toBe(true);

		// QuickBooks kept the original category: no clobber on a stale write.
		const remote = mock.get('Purchase', 'p1');
		expect(remote && lineAccount(remote)).toBe('60');
		expect(remote?.SyncToken).toBe('5');
		cleanup();
	});

	test('errors clearly when the transaction is not in the mirror', async () => {
		const { catalog, cleanup } = await setup();
		const outcome = await recategorize(catalog, {
			entity: 'Purchase',
			id: 'does-not-exist',
			account_id: '77',
		});
		expect(outcome.isError).toBe(true);
		expect(String(outcome.output)).toContain('mirror');
		cleanup();
	});
});
