/**
 * The Purchase/Deposit projections, pinned against the real QuickBooks object
 * shapes. These are SQLite GENERATED columns over `json_extract(raw, ...)`, so
 * the test inserts a raw blob and reads the columns back: it proves the JSON
 * paths are right (header scalars only; the line-level category stays in `raw`)
 * and that a sparse object projects to nulls rather than failing the insert.
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { type BooksDb, openBooksDb } from '../src/db.ts';
import { entityDef, type QbObject } from '../src/entities.ts';
import { tempDir } from './helpers.ts';

/** Open a throwaway mirror, upsert one object, return its projected columns. */
function project(entity: string, raw: QbObject): Record<string, unknown> {
	const def = entityDef(entity);
	const tmp = tempDir();
	let db: BooksDb | undefined;
	try {
		db = openBooksDb(join(tmp.dir, 'books.db'));
		const id = String(raw.Id);
		db.applyEntitySync(def, {
			upserts: [{ id, raw: JSON.stringify(raw), updatedAt: null }],
			deletes: [],
			syncState: {
				entity,
				cdcCursor: null,
				lastFullPullAt: null,
				lastSyncedAt: null,
			},
			syncedAt: '2026-06-21T00:00:00.000Z',
		});
		const cols = def.columns.map((c) => c.name).join(', ');
		return db.raw
			.query(`SELECT ${cols} FROM ${def.table} WHERE id = ?`)
			.get(id) as Record<string, unknown>;
	} finally {
		db?.close();
		tmp.cleanup();
	}
}

describe('Purchase projection', () => {
	test('lifts the header scalars from a live-shaped object', () => {
		const purchase: QbObject = {
			Id: '855',
			TxnDate: '2026-05-21',
			TotalAmt: 200,
			PaymentType: 'Cash',
			AccountRef: { value: '11', name: 'Every Bank Account' },
			EntityRef: { value: '112', name: 'Anthropic (Expense)', type: 'Vendor' },
			Line: [
				{ AccountBasedExpenseLineDetail: { AccountRef: { name: 'IT Costs' } } },
			],
		};
		expect(project('Purchase', purchase)).toEqual({
			txn_date: '2026-05-21',
			total_amt: 200,
			payment_type: 'Cash',
			account_ref: 'Every Bank Account',
			payee: 'Anthropic (Expense)',
		});
	});

	test('a sparse object (missing fields) projects to nulls', () => {
		const sparse: QbObject = { Id: '855' };
		expect(project('Purchase', sparse)).toEqual({
			txn_date: null,
			total_amt: null,
			payment_type: null,
			account_ref: null,
			payee: null,
		});
	});
});

describe('Deposit projection', () => {
	test('reads the deposit-to account from DepositToAccountRef', () => {
		const deposit: QbObject = {
			Id: '815',
			TxnDate: '2026-02-05',
			TotalAmt: 1500,
			DepositToAccountRef: { value: '9', name: 'Arc Business account (2249)' },
			Line: [{ DepositLineDetail: { AccountRef: { name: '40000 Revenue' } } }],
		};
		expect(project('Deposit', deposit)).toEqual({
			txn_date: '2026-02-05',
			total_amt: 1500,
			deposit_to: 'Arc Business account (2249)',
		});
	});
});
