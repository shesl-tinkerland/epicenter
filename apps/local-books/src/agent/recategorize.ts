/**
 * `recategorize_expense`: the one QuickBooks write-back tool (ADR-0047). It
 * moves an expense transaction's category by sparse-updating the `AccountRef` on
 * its expense lines, then folds QuickBooks' response back into the local mirror.
 *
 * It is a `mutation`, so the client agent loop pauses for approval before
 * dispatching it (unlike the auto-approved `books_sql_query`). The write is
 * write-THROUGH: QuickBooks owns the change; the mirror is updated from the
 * authoritative response (with the bumped `SyncToken`), and the next CDC sync
 * reconfirms it. The mirror is never the write target.
 *
 * Concurrency: the current `SyncToken` is read from the mirror and sent with the
 * update. If a bookkeeper changed the object in QuickBooks since the last sync,
 * QuickBooks rejects the stale token (a 409 `Http` error) rather than clobbering
 * their change; the caller should re-sync and retry.
 */

import { defineMutation } from '@epicenter/workspace';
import { Type } from 'typebox';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok } from 'wellcrafted/result';
import { openBooksDb } from '../db.ts';
import { entityDef, lastUpdatedTime } from '../entities.ts';
import type { OpenQbClient } from './qb-access.ts';

/** The line shape that carries an account-based expense category. */
const LINE_DETAIL = 'AccountBasedExpenseLineDetail';

export const RecategorizeError = defineErrors({
	WriteBackUnavailable: ({ detail }: { detail: string }) => ({
		message: `Recategorize is unavailable: ${detail}`,
		detail,
	}),
	NotInMirror: ({ entity, id }: { entity: string; id: string }) => ({
		message: `No ${entity} ${id} in the local mirror. Run \`local-books sync\` first.`,
	}),
	NoExpenseLine: ({
		entity,
		id,
		lineId,
	}: {
		entity: string;
		id: string;
		lineId?: string;
	}) => ({
		message: lineId
			? `${entity} ${id} has no expense line ${lineId} to recategorize.`
			: `${entity} ${id} has no account-based expense line to recategorize.`,
	}),
});
export type RecategorizeError = InferErrors<typeof RecategorizeError>;

const RecategorizeInput = Type.Object({
	entity: Type.Union([Type.Literal('Purchase'), Type.Literal('Bill')], {
		description:
			'Which expense transaction to recategorize: a Purchase (card/cash/check expense) or a Bill (vendor bill).',
	}),
	id: Type.String({
		minLength: 1,
		description: 'The QuickBooks Id of the transaction (the mirror row `id`).',
	}),
	account_id: Type.String({
		minLength: 1,
		description:
			'The target expense account Id (an `accounts` row `id`), set as the line AccountRef.value.',
	}),
	account_name: Type.Optional(
		Type.String({
			description:
				'The target account display name, set as AccountRef.name (for readable books).',
		}),
	),
	line_id: Type.Optional(
		Type.String({
			description:
				'Recategorize only this line (its `Id`). Omit to recategorize every expense line on the transaction.',
		}),
	),
});

type ExpenseLine = Record<string, unknown> & {
	Id?: string | number;
	[LINE_DETAIL]?: { AccountRef?: { value?: string; name?: string } };
};

/** Build the `recategorize_expense` mutation over the mirror at `dbPath`. */
export function createRecategorizeAction({
	openQb,
	dbPath,
	now,
}: {
	openQb: OpenQbClient | undefined;
	dbPath: string;
	now: () => number;
}) {
	return defineMutation({
		title: 'Recategorize an expense',
		description:
			'Move an expense transaction to a different account (its category) in ' +
			'QuickBooks, then update the local mirror. Targets the expense lines of a ' +
			'Purchase or Bill. Find the transaction and the target account first with ' +
			'`books_sql_query` (the current category lives in raw, e.g. ' +
			"json_extract(raw, '$.Line')).",
		input: RecategorizeInput,
		handler: async (input) => {
			if (!openQb) {
				return RecategorizeError.WriteBackUnavailable({
					detail: 'this daemon was started without a QuickBooks client',
				});
			}
			const def = entityDef(input.entity);
			const db = openBooksDb(dbPath);
			try {
				const tableExists = db.raw
					.query(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`)
					.get(def.table);
				if (!tableExists) {
					return RecategorizeError.NotInMirror({
						entity: input.entity,
						id: input.id,
					});
				}
				const row = db.raw
					.query<{ raw: string }, [string]>(
						`SELECT raw FROM ${def.table} WHERE id = ? AND deleted = 0`,
					)
					.get(input.id);
				if (!row) {
					return RecategorizeError.NotInMirror({
						entity: input.entity,
						id: input.id,
					});
				}

				const obj = JSON.parse(row.raw) as Record<string, unknown>;
				const lines: ExpenseLine[] = Array.isArray(obj.Line)
					? (obj.Line as ExpenseLine[])
					: [];
				const targets = lines.filter(
					(line) =>
						line[LINE_DETAIL] != null &&
						(input.line_id == null || String(line.Id) === input.line_id),
				);
				if (targets.length === 0) {
					return RecategorizeError.NoExpenseLine({
						entity: input.entity,
						id: input.id,
						lineId: input.line_id,
					});
				}

				const toName = input.account_name ?? input.account_id;
				const changed = targets.map((line) => {
					const detail = line[LINE_DETAIL];
					const fromRef = detail?.AccountRef;
					const change = {
						lineId: line.Id != null ? String(line.Id) : null,
						fromAccount: fromRef?.name ?? fromRef?.value ?? null,
						toAccount: toName,
					};
					line[LINE_DETAIL] = {
						...detail,
						AccountRef: {
							value: input.account_id,
							...(input.account_name ? { name: input.account_name } : {}),
						},
					};
					return change;
				});

				const { data: qb, error: openError } = await openQb();
				if (openError !== null) {
					return RecategorizeError.WriteBackUnavailable({ detail: openError });
				}

				// Sparse update: send the full (modified) Line array with Id + the
				// SyncToken read from the mirror; QuickBooks merges the named fields.
				const { data: updated, error } = await qb.update(input.entity, {
					Id: obj.Id,
					SyncToken: obj.SyncToken,
					sparse: true,
					Line: lines,
				});
				// Re-wrap as a Result: a bare error variant would be Ok-wrapped by
				// invokeAction and read as success. A stale SyncToken (409) lands here.
				if (error) return Err(error);

				db.upsertObjects(
					def,
					[
						{
							id: String(updated.Id),
							raw: JSON.stringify(updated),
							updatedAt: lastUpdatedTime(updated),
						},
					],
					new Date(now()).toISOString(),
				);

				return Ok({
					entity: input.entity,
					id: String(updated.Id),
					changed,
					syncToken:
						typeof updated.SyncToken === 'string' ? updated.SyncToken : null,
				});
			} finally {
				db.close();
			}
		},
	});
}
