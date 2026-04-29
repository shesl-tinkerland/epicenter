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
 * via this slot: validation happens only on the `/run` envelope shape, and
 * `invokeAction` simply forwards the payload to the handler. The slot's
 * runtime job is to publish a JSON Schema document for the manifest and AI
 * tool bridges. We honor that contract by routing arktype through its
 * `StandardJSONSchemaV1` emitter and wrapping the resulting JSON Schema in
 * `Type.Unsafe<T>` so `defineQuery` / `defineMutation` can still infer the
 * handler input type.
 *
 * Phase 4 of `specs/20260429T004302-workspace-as-daemon-transport.md`.
 */

import { type } from 'arktype';
import Type from 'typebox';
import type { TUnsafe } from 'typebox';
import type { BaseRow, Table } from '../document/attach-table.js';
import type { CombinedStandardSchema } from '../document/standard-schema.js';
import { defineMutation, defineQuery } from '../shared/actions.js';
import { partialUpdate } from '../shared/schema-partial.js';
import { standardSchemaToJsonSchema } from '../shared/standard-schema.js';

/**
 * Convert a Standard-Schema-with-JSON-Schema source (arktype, zod 4.2+,
 * valibot 1.2+) into a typebox `TUnsafe<T>` by routing through the
 * `~standard.jsonSchema.input` emitter (via `standardSchemaToJsonSchema`,
 * which calls the converter as a method to stay spec-compliant). The
 * result is a real draft-2020-12 JSON Schema document with `T` carried as
 * the inferred static type.
 *
 * `T` is explicit: the schema's structural inference may differ from the
 * branded handler-input type (e.g. `partialUpdate` widens optionality, the
 * ID slot carries a brand). The static parameter overrides inference at
 * the call site without changing the runtime JSON Schema.
 */
function toTSchema<T>(schema: CombinedStandardSchema): TUnsafe<T> {
	return Type.Unsafe<T>(standardSchemaToJsonSchema(schema));
}

export function buildTableActions<TRow extends BaseRow>(
	table: Table<TRow>,
	tableName: string,
) {
	const rowSchema = table.definition.schema;
	// Patch schema: `id` required, all other fields optional. Brand survives.
	const patchSchema = partialUpdate(rowSchema as never);

	type Patch = { id: TRow['id'] } & Partial<Omit<TRow, 'id'>>;

	const idInput = toTSchema<{ id: string }>(type({ id: 'string' }));
	const rowInput = toTSchema<TRow>(rowSchema);
	const patchInput = toTSchema<Patch>(patchSchema);
	const bulkInput = toTSchema<{ rows: TRow[] }>(type({ rows: 'unknown[]' }));

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
			handler: (input) => table.update(input as Patch),
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
