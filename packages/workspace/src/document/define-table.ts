/**
 * defineTable() for creating versioned table definitions.
 *
 * All table schemas must include `_v: number` as a discriminant field.
 * The underscore prefix signals framework metadata—see `BaseRow` in
 * `types.ts` for the full rationale.
 *
 * Use shorthand for single-version tables, variadic args for multiple versions with migrations.
 *
 * @example
 * ```typescript
 * import { defineTable } from '@epicenter/workspace';
 * import { type } from 'arktype';
 *
 * // Shorthand for single version
 * const users = defineTable(type({ id: 'string', email: 'string', _v: '1' }));
 *
 * // Variadic for multiple versions with migration
 * const posts = defineTable(
 *   type({ id: 'string', title: 'string', _v: '1' }),
 *   type({ id: 'string', title: 'string', views: 'number', _v: '2' }),
 * ).migrate((row) => {
 *   switch (row._v) {
 *     case 1: return { ...row, views: 0, _v: 2 };
 *     case 2: return row;
 *   }
 * });
 * ```
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import type {
	BaseRow,
	LastSchema,
	TableDefinition,
} from './attach-table.js';
import { createUnionSchema } from './schema-union.js';
import type { CombinedStandardSchema } from './standard-schema.js';

/**
 * Creates a table definition with a single schema version.
 * Schema must include `{ id: string, _v: number }`.
 */
export function defineTable<TSchema extends CombinedStandardSchema<BaseRow>>(
	schema: TSchema,
): TableDefinition<[TSchema]>;

/**
 * Creates a table definition for multiple schema versions with migrations.
 *
 * Pass 2+ schemas as arguments, then call `.migrate()` on the result to provide
 * a migration function that normalizes any version to the latest.
 */
export function defineTable<
	const TVersions extends [
		CombinedStandardSchema<BaseRow>,
		CombinedStandardSchema<BaseRow>,
		...CombinedStandardSchema<BaseRow>[],
	],
>(
	...versions: TVersions
): {
	migrate(
		fn: (
			row: StandardSchemaV1.InferOutput<TVersions[number]>,
		) => StandardSchemaV1.InferOutput<LastSchema<TVersions>>,
	): TableDefinition<TVersions>;
};

export function defineTable<TSchema extends CombinedStandardSchema<BaseRow>>(
	...args: [TSchema, ...CombinedStandardSchema<BaseRow>[]]
):
	| TableDefinition<[TSchema]>
	| {
			migrate(
				fn: (row: unknown) => unknown,
			): TableDefinition<CombinedStandardSchema<BaseRow>[]>;
	  } {
	if (args.length === 0) {
		throw new Error('defineTable() requires at least one schema argument');
	}

	if (args.length === 1) {
		const schema = args[0];
		return {
			schema,
			migrate: (row: unknown) => row as BaseRow,
		} as unknown as TableDefinition<[TSchema]>;
	}

	const versions = args as CombinedStandardSchema[];

	return {
		migrate(fn: (row: unknown) => unknown) {
			return {
				schema: createUnionSchema(versions),
				migrate: fn,
			};
		},
	} as unknown as {
		migrate(
			fn: (row: unknown) => unknown,
		): TableDefinition<CombinedStandardSchema<BaseRow>[]>;
	};
}
