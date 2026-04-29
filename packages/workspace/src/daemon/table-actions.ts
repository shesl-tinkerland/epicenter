/**
 * Auto-generates the standard CRUD action set for a `Table`. Each entry is a
 * `defineQuery` or `defineMutation` instance, callable both in-process (the
 * action callable IS the handler) and over the daemon's `/run` route.
 *
 * Plug this onto a workspace bundle so the daemon can route to it:
 *
 * ```ts
 * actions: {
 *   tables: {
 *     entries: buildTableActions(tables.entries, 'entries'),
 *   },
 * }
 * ```
 *
 * ## Input schemas
 *
 * The wire-side `input` slot on `defineQuery` / `defineMutation` is typed as
 * typebox `TSchema`, but the workspace's table schemas are arktype Types
 * (Standard-Schema-shaped). At runtime the daemon does not validate `input`
 * via this slot — it's metadata for the manifest and for AI tool bridges.
 * `invokeAction` simply forwards the value to the handler. Feeding arktype
 * schemas through the slot is therefore safe; we cast through `unknown` to
 * the typebox shape and rely on each handler's explicit parameter type to
 * keep the call site honest.
 *
 * Phase 4 of `specs/20260429T004302-workspace-as-daemon-transport.md`.
 */

import Type from 'typebox';
import type { TUnsafe } from 'typebox';
import { type } from 'arktype';
import { defineMutation, defineQuery } from '../shared/actions.js';
import { partialUpdate } from '../shared/schema-partial.js';
import type { BaseRow, Table } from '../document/attach-table.js';

/**
 * Wrap a runtime arktype schema as a typebox-shaped slot whose `Static<>`
 * resolves to `T`. The daemon does not validate `action.input` against
 * incoming payloads (validation happens only on the `/run` envelope shape),
 * so `Type.Unsafe` is enough to carry the inferred handler type while
 * leaving the live arktype schema callable on the action's `input` property
 * for AI bridges and the manifest. The runtime value IS the arktype schema;
 * the typebox projection is decorative metadata that lets `defineMutation` /
 * `defineQuery` type each handler's input correctly.
 */
function arkAsTSchema<T>(schema: unknown): TUnsafe<T> {
	return Object.assign(schema as object, Type.Unsafe<T>({})) as TUnsafe<T>;
}

export function buildTableActions<TRow extends BaseRow>(
	table: Table<TRow>,
	tableName: string,
) {
	const rowSchema = table.definition.schema;
	// Patch schema: `id` required, all other fields optional. Brand survives.
	const patchSchema = partialUpdate(rowSchema as never);

	type Patch = { id: TRow['id'] } & Partial<Omit<TRow, 'id'>>;

	const idInput = arkAsTSchema<{ id: string }>(type({ id: 'string' }));
	const rowInput = arkAsTSchema<TRow>(rowSchema);
	const patchInput = arkAsTSchema<Patch>(patchSchema);
	const bulkInput = arkAsTSchema<{ rows: TRow[] }>(
		type({ rows: 'unknown[]' }),
	);

	return {
		get: defineQuery({
			title: `Get ${tableName}`,
			description: `Get a single row from \`${tableName}\` by id.`,
			input: idInput,
			handler: ({ id }) => table.get(id as TRow['id']),
		}),

		getAllValid: defineQuery({
			title: `Get all ${tableName}`,
			description: `Get every row from \`${tableName}\` that passes schema validation.`,
			handler: () => table.getAllValid(),
		}),

		set: defineMutation({
			title: `Set ${tableName}`,
			description: `Insert or replace a single row in \`${tableName}\`.`,
			input: rowInput,
			handler: (row) => {
				table.set(row);
			},
		}),

		update: defineMutation({
			title: `Update ${tableName}`,
			description: `Patch a single row in \`${tableName}\` by id.`,
			input: patchInput,
			handler: ({ id, ...patch }) =>
				table.update(id, patch as Partial<Omit<TRow, 'id'>>),
		}),

		delete: defineMutation({
			title: `Delete ${tableName}`,
			description: `Hard-delete a row from \`${tableName}\` by id.`,
			input: idInput,
			handler: ({ id }) => {
				table.delete(id);
			},
		}),

		bulkSet: defineMutation({
			title: `Bulk set ${tableName}`,
			description: `Insert or replace many rows in \`${tableName}\`.`,
			input: bulkInput,
			handler: ({ rows }) => table.bulkSet(rows),
		}),
	};
}
