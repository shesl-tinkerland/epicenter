/**
 * `books_report` reached as a dispatched action, driven against the mock
 * QuickBooks Reports endpoint. Proves the live passthrough: a tool call hits the
 * QuickBooks Reports API (no mirror, no cache) and the report comes back with the
 * period params passed through.
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
import { startMockQbServer } from '../../test/mock-qb-server.ts';
import { createFileKeyring } from '../keyring.ts';
import type { TokenSet } from '../tokens.ts';
import { createBooksAgentActions } from './books-actions.ts';
import { makeQbAccess } from './qb-access.ts';

const LOCAL_ONLY: DispatchSurface = {
	peers: { list: () => [] },
	dispatch: () => Promise.resolve(Ok(null)),
};

const NOW = Date.parse('2026-02-01T00:00:00.000Z');
const now = () => NOW;

async function setup() {
	const dir = mkdtempSync(join(tmpdir(), 'local-books-'));
	const mock = startMockQbServer({ now });
	const keyringFile = join(dir, 'keyring.json');
	const config = makeConfig({
		dataDir: dir,
		apiBase: mock.apiBase,
		tokenUrl: mock.tokenUrl,
		keyringFile,
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

	const openQb = makeQbAccess({ config, realmId: mock.realmId, keyring, now });
	const catalog = createDispatchToolCatalog(LOCAL_ONLY, {
		localActions: createBooksAgentActions({
			dbPath: join(dir, mock.realmId, 'books.db'),
			openQb,
			now,
		}),
	});
	return {
		mock,
		catalog,
		cleanup: () => {
			mock.stop();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

describe('books_report as a dispatched action', () => {
	test('runs a report live against QuickBooks and passes the period through', async () => {
		const { mock, catalog, cleanup } = await setup();

		const outcome = await catalog.resolve(
			{
				toolCallId: 't1',
				toolName: 'books_report',
				input: {
					report: 'ProfitAndLoss',
					start_date: '2026-01-01',
					end_date: '2026-03-31',
				},
			},
			new AbortController().signal,
		);

		expect(outcome.isError).toBe(false);
		expect(mock.hits.report).toBe(1);
		const output = outcome.output as {
			report: string;
			data: { Header: { ReportName: string; StartPeriod: string } };
		};
		expect(output.report).toBe('ProfitAndLoss');
		expect(output.data.Header.ReportName).toBe('ProfitAndLoss');
		expect(output.data.Header.StartPeriod).toBe('2026-01-01');
		cleanup();
	});
});
