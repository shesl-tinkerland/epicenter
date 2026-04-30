/**
 * attachTable(): Bind a TableDefinition to a Y.Doc.
 *
 * Constructs an unencrypted `YKeyValueLww` on `ydoc.getArray('table:<name>')`
 * and wraps it with a typed `Table`. Provides CRUD operations with
 * schema validation and migration on read.
 *
 * For encrypted storage, call `encryption.attachTable` / `encryption.attachKv`
 * on the coordinator returned by `attachEncryption(ydoc)`.
 *
 * The CRUD methods (`get`, `getAllValid`, `set`, `update`, `delete`,
 * `bulkSet`) are constructed as `defineQuery` / `defineMutation` instances
 * directly, so they are callable in-process and crossable over the wire
 * without a separate wrapper layer. Plain methods (`filter`, `observe`,
 * `find`, `count`, `has`, `getAll`, `getAllInvalid`, `bulkDelete`, `clear`,
 * `parse`) stay unbranded and only exist locally.
 *
 * @example
 * ```typescript
 * import * as Y from 'yjs';
 * import { defineTable, attachTable } from '@epicenter/workspace';
 * import { type } from 'arktype';
 *
 * const posts = defineTable(type({ id: 'string', title: 'string', _v: '1' }));
 * const ydoc = new Y.Doc({ guid: 'my-doc' });
 * const postsTable = attachTable(ydoc, 'posts', posts);
 * postsTable.set({ id: '1', title: 'Hello', _v: 1 });
 * ```
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import Type from 'typebox';
import type { TUnsafe } from 'typebox';
import { defineErrors, extractErrorMessage, type InferErrors } from 'wellcrafted/error';
import type { JsonObject } from 'wellcrafted/json';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type * as Y from 'yjs';
import {
	defineMutation,
	defineQuery,
	type Mutation,
	type Query,
} from '@epicenter/sync';
import { partialUpdate } from '../shared/schema-partial.js';
import { standardSchemaToJsonSchema } from '../shared/standard-schema.js';
import { TableKey } from './keys.js';
import type { CombinedStandardSchema } from './standard-schema.js';
import {
	type KvStoreChangeHandler,
	type ObservableKvStore,
	YKeyValueLww,
	type YKeyValueLwwEntry,
} from './y-keyvalue/index.js';

// ════════════════════════════════════════════════════════════════════════════
// TABLE PARSE ERROR
// ════════════════════════════════════════════════════════════════════════════

/**
 * Errors produced when parsing unknown input against a table's schema.
 *
 * Surfaced by `parse()`, `get()`, `getAll()`, and `update()`. "Not found" on
 * `get()` / `update()` is *not* an error: it's a legitimate absence and is
 * returned as `data: null` instead.
 */
export const TableParseError = defineErrors({
	/** Standard Schema validation produced issues. */
	ValidationFailed: ({
		id,
		issues,
		row,
	}: {
		id: string;
		issues: readonly StandardSchemaV1.Issue[];
		row: unknown;
	}) => ({
		message: `Row '${id}' failed schema validation: ${issues.map((i) => i.message).join('; ')}`,
		id,
		issues,
		row,
	}),
	/** The table's schema returned a `Promise` from `validate()`: not supported. */
	AsyncSchemaNotSupported: ({ id }: { id: string }) => ({
		message: `Row '${id}' could not be parsed: async Standard Schema validate() is not supported`,
		id,
	}),
	/** The migration function threw while upgrading a valid-at-parse-time row. */
	MigrationFailed: ({ id, cause }: { id: string; cause: unknown }) => ({
		message: `Row '${id}' could not be migrated: ${extractErrorMessage(cause)}`,
		id,
		cause,
	}),
});
export type TableParseError = InferErrors<typeof TableParseError>;

// ════════════════════════════════════════════════════════════════════════════
// ROW TYPE
// ════════════════════════════════════════════════════════════════════════════

/**
 * The minimum shape every versioned table row must satisfy.
 *
 * - `id`: Unique identifier for row lookup and identity
 * - `_v`: Schema version number for tracking which version this row conforms to
 *
 * Intersected with `JsonObject` to ensure all field values are JSON-serializable.
 */
export type BaseRow = { id: string; _v: number } & JsonObject;

// ════════════════════════════════════════════════════════════════════════════
// TABLE DEFINITION TYPES
// ════════════════════════════════════════════════════════════════════════════

/** Extract the last element from a tuple of schemas. */
export type LastSchema<T extends readonly CombinedStandardSchema[]> =
	T extends readonly [
		...CombinedStandardSchema[],
		infer L extends CombinedStandardSchema,
	]
		? L
		: T[number];

/**
 * A table definition created by `defineTable(schema)` or `defineTable(v1, v2, ...).migrate(fn)`.
 *
 * For per-row content (rich text, long-form body), keep the row lean (ids,
 * metadata, a content-doc guid) and pair the table with a separate
 * `createDisposableCache(builder)` keyed on that content guid. Opening a row
 * then becomes `contentDocs.open(row.contentGuid)`: the list doesn't load
 * every content doc, and the editor doesn't contend with the table.
 *
 * @typeParam TVersions - Tuple of schema versions (each must include `{ id: string }`)
 */
export type TableDefinition<
	TVersions extends readonly CombinedStandardSchema<BaseRow>[] = readonly CombinedStandardSchema<BaseRow>[],
> = {
	schema: CombinedStandardSchema<
		unknown,
		StandardSchemaV1.InferOutput<TVersions[number]>
	>;
	migrate: (
		row: StandardSchemaV1.InferOutput<TVersions[number]>,
	) => StandardSchemaV1.InferOutput<LastSchema<TVersions>>;
};

/** Extract the row type from a TableDefinition */
export type InferTableRow<T> = T extends {
	migrate: (...args: never[]) => infer TLatest;
}
	? TLatest
	: never;

/** Map of table definitions (uses `any` to allow variance in generic parameters) */
export type TableDefinitions = Record<
	string,
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly map type
	TableDefinition<any>
>;

// ════════════════════════════════════════════════════════════════════════════
// TABLE HELPER TYPE
// ════════════════════════════════════════════════════════════════════════════

/** Patch shape for `update`: `id` required, every other field optional. */
export type TablePatch<TRow extends BaseRow> = { id: TRow['id'] } & Partial<
	Omit<TRow, 'id'>
>;

/**
 * Type-safe runtime handle for a single workspace table.
 *
 * Provides CRUD operations with schema validation and migration on read.
 *
 * The CRUD methods (`get`, `getAllValid`, `set`, `update`, `delete`,
 * `bulkSet`) are branded `Query` / `Mutation` instances. The brand is the
 * cut-line for what crosses the wire to a remote workspace; plain methods
 * stay local.
 *
 * @typeParam TRow - The fully-typed row shape for this table (extends `{ id: string }`)
 */
export type Table<TRow extends BaseRow> = {
	/** The table name (the Y.Array key this table is bound to). */
	name: string;

	/**
	 * The underlying `TableDefinition` (schema + migration) this Table was
	 * attached with. Exposed for consumers that need the raw schema, e.g.,
	 * the sqlite materializer generating DDL.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly: defineTable already constrains schemas
	definition: TableDefinition<any>;

	/**
	 * Parse unknown input against the table schema and migrate to the latest
	 * version.
	 *
	 * Injects `id` into the input before validation. Does not write to storage.
	 */
	parse(id: string, input: unknown): Result<TRow, TableParseError>;

	/**
	 * Get a single row by ID.
	 *
	 * Branded: addressable over the wire as `tables.<name>.get(id)`.
	 */
	get: Query<TUnsafe<string>, Result<TRow | null, TableParseError>>;

	/**
	 * Get all rows that pass schema validation.
	 *
	 * Branded: addressable over the wire as `tables.<name>.getAllValid()`.
	 */
	getAllValid: Query<undefined, TRow[]>;

	/**
	 * Set a row (insert or replace). Always writes the full row.
	 *
	 * Branded: addressable over the wire as `tables.<name>.set(row)`.
	 */
	set: Mutation<TUnsafe<TRow>, void>;

	/**
	 * Insert or replace many rows in chunked transactions.
	 *
	 * Branded: addressable over the wire as `tables.<name>.bulkSet(rows)`.
	 */
	bulkSet: Mutation<TUnsafe<TRow[]>, Promise<void>>;

	/**
	 * Partial update a row by ID.
	 *
	 * Branded: addressable over the wire as `tables.<name>.update({ id, ...patch })`.
	 * Returns `data: null` when no row exists at that id (not an error).
	 */
	update: Mutation<
		TUnsafe<TablePatch<TRow>>,
		Result<TRow | null, TableParseError>
	>;

	/**
	 * Delete a single row by ID.
	 *
	 * Branded: addressable over the wire as `tables.<name>.delete(id)`.
	 */
	delete: Mutation<TUnsafe<string>, void>;

	/** Get all rows with their validation outcome. Local only. */
	getAll(): Array<Result<TRow, TableParseError>>;

	/** Get all rows that fail schema validation. Local only. */
	getAllInvalid(): TableParseError[];

	/** Filter valid rows by predicate. Local only (closure). */
	filter(predicate: (row: TRow) => boolean): TRow[];

	/** Find the first valid row matching a predicate. Local only (closure). */
	find(predicate: (row: TRow) => boolean): TRow | undefined;

	/** Delete many rows by ID with chunked operations and progress reporting. Local only (callback closure). */
	bulkDelete(
		ids: string[],
		options?: {
			chunkSize?: number;
			onProgress?: (percent: number) => void;
		},
	): Promise<void>;

	/** Delete all rows from the table. Local only. */
	clear(): void;

	/** Watch for row changes. Local only (closure). */
	observe(
		callback: (changedIds: ReadonlySet<TRow['id']>, origin?: unknown) => void,
	): () => void;

	/** Get the total number of rows in the table. Local only. */
	count(): number;

	/** Check if a row exists by ID. Local only. */
	has(id: string): boolean;
};

/** Map keyed by table name to Table for that table's row type. */
export type Tables<TTableDefinitions extends TableDefinitions> = {
	[K in keyof TTableDefinitions]: Table<InferTableRow<TTableDefinitions[K]>>;
};

/**
 * Bind a single TableDefinition to a Y.Doc and return a typed Table.
 *
 * Creates (or reuses) a Y.Array at `table:<name>` and wraps it with an
 * unencrypted `YKeyValueLww` store.
 *
 * @param ydoc - The Y.Doc to attach to
 * @param name - The table name (used as the Y.Array key)
 * @param definition - The table definition with schema and migration
 */
export function attachTable<
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly: defineTable already constrains schemas
	TTableDefinition extends TableDefinition<any>,
>(
	ydoc: Y.Doc,
	name: string,
	definition: TTableDefinition,
): Table<InferTableRow<TTableDefinition>> {
	const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(TableKey(name));
	const ykv = new YKeyValueLww<unknown>(yarray);
	ydoc.on('destroy', () => ykv.dispose());
	return createTable(ykv, definition, name);
}

/**
 * Bind a record of plaintext `TableDefinition`s to a Y.Doc. Sugar over
 * `attachTable`: calls it for each entry and returns the helpers keyed by
 * table name.
 *
 * For encrypted storage, call `encryption.attachTables` on the coordinator
 * returned by `attachEncryption(ydoc)`.
 */
export function attachTables<T extends TableDefinitions>(
	ydoc: Y.Doc,
	definitions: T,
): Tables<T> {
	return Object.fromEntries(
		Object.entries(definitions).map(([name, def]) => [
			name,
			attachTable(ydoc, name, def),
		]),
	) as Tables<T>;
}

/**
 * Convert a Standard Schema (arktype, zod 4.2+, valibot 1.2+) into a typebox
 * `TUnsafe<T>` by routing through the `~standard.jsonSchema.input` emitter.
 * The result is a draft-2020-12 JSON Schema document with `T` carried as the
 * inferred static type.
 *
 * `T` is explicit: the schema's structural inference may differ from the
 * branded handler-input type (e.g. `partialUpdate` widens optionality, the ID
 * slot may carry a brand). The static parameter overrides inference at the
 * call site without changing the runtime JSON Schema.
 */
function toTSchema<T>(schema: CombinedStandardSchema): TUnsafe<T> {
	return Type.Unsafe<T>(standardSchemaToJsonSchema(schema));
}

/**
 * Construct a Table from any `ObservableKvStore` and a TableDefinition.
 *
 * Exported so `@epicenter/workspace` can reuse the exact same helper logic
 * over its encrypted store wrapper.
 */
export function createTable<
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly: defineTable already constrains schemas
	TTableDefinition extends TableDefinition<any>,
>(
	ykv: ObservableKvStore<unknown>,
	definition: TTableDefinition,
	name: string,
): Table<InferTableRow<TTableDefinition>> {
	type TRow = InferTableRow<TTableDefinition>;

	const rowSchema = definition.schema as CombinedStandardSchema;

	const idTSchema = Type.Unsafe<string>({ type: 'string' });
	const rowTSchema = toTSchema<TRow>(rowSchema);
	// `partialUpdate` is arktype-specific (uses `.pick`/`.omit`/`.partial`).
	// Multi-version tables compose a non-arktype union schema, so fall back to
	// a permissive JSON Schema for the manifest. Runtime validation happens at
	// the daemon envelope only, not on the action's `input` slot.
	let patchTSchema: TUnsafe<TablePatch<TRow>>;
	try {
		const patchSchema = partialUpdate(rowSchema as never);
		patchTSchema = toTSchema<TablePatch<TRow>>(
			patchSchema as unknown as CombinedStandardSchema,
		);
	} catch {
		patchTSchema = Type.Unsafe<TablePatch<TRow>>({ type: 'object' });
	}
	const rowsTSchema = Type.Unsafe<TRow[]>({
		type: 'array',
		items: standardSchemaToJsonSchema(rowSchema),
	});

	function parseRow(id: string, input: unknown): Result<TRow, TableParseError> {
		const row = { ...(input as Record<string, unknown>), id };
		const result = definition.schema['~standard'].validate(row);
		if (result instanceof Promise) {
			return TableParseError.AsyncSchemaNotSupported({ id });
		}
		if (result.issues) {
			return TableParseError.ValidationFailed({
				id,
				issues: result.issues,
				row,
			});
		}
		try {
			const migrated = definition.migrate(result.value) as TRow;
			return Ok(migrated);
		} catch (cause) {
			return TableParseError.MigrationFailed({ id, cause });
		}
	}

	function getRow(id: string): Result<TRow | null, TableParseError> {
		const raw = ykv.get(id);
		if (raw === undefined) return Ok(null);
		return parseRow(id, raw);
	}

	function setRow(row: TRow): void {
		ykv.set(row.id, row);
	}

	return {
		name,
		definition,

		parse: parseRow,

		get: defineQuery({
			title: `Get ${name}`,
			description: `Get a single row from \`${name}\` by id.`,
			input: idTSchema,
			handler: getRow,
		}),

		getAllValid: defineQuery({
			title: `Get all ${name}`,
			description: `Get every row from \`${name}\` that passes schema validation.`,
			handler: (): TRow[] => {
				const rows: TRow[] = [];
				for (const [key, entry] of ykv.entries()) {
					const { data, error } = parseRow(key, entry.val);
					if (!error) rows.push(data);
				}
				return rows;
			},
		}),

		set: defineMutation({
			title: `Set ${name}`,
			description: `Insert or replace a single row in \`${name}\`.`,
			input: rowTSchema,
			handler: setRow,
		}),

		bulkSet: defineMutation({
			title: `Bulk set ${name}`,
			description: `Insert or replace many rows in \`${name}\`.`,
			input: rowsTSchema,
			handler: async (rows: TRow[]) => {
				const chunkSize = 1000;
				for (let i = 0; i < rows.length; i += chunkSize) {
					const chunk = rows.slice(i, i + chunkSize);
					ykv.bulkSet(chunk.map((row) => ({ key: row.id, val: row })));
					await new Promise((resolve) => setTimeout(resolve, 0));
				}
			},
		}),

		update: defineMutation({
			title: `Update ${name}`,
			description: `Patch a single row in \`${name}\` by id.`,
			input: patchTSchema,
			handler: (input: TablePatch<TRow>): Result<TRow | null, TableParseError> => {
				const { id, ...partial } = input;
				const { data: current, error: currentError } = getRow(id);
				if (currentError) return Err(currentError);
				if (current === null) return Ok(null);

				const merged = { ...current, ...partial, id };
				const { data: validated, error: mergedError } = parseRow(id, merged);
				if (mergedError) return Err(mergedError);

				setRow(validated);
				return Ok(validated);
			},
		}),

		delete: defineMutation({
			title: `Delete ${name}`,
			description: `Hard-delete a row from \`${name}\` by id.`,
			input: idTSchema,
			handler: (id: string) => {
				ykv.delete(id);
			},
		}),

		getAll(): Array<Result<TRow, TableParseError>> {
			const results: Array<Result<TRow, TableParseError>> = [];
			for (const [key, entry] of ykv.entries()) {
				results.push(parseRow(key, entry.val));
			}
			return results;
		},

		getAllInvalid(): TableParseError[] {
			const invalid: TableParseError[] = [];
			for (const [key, entry] of ykv.entries()) {
				const { error } = parseRow(key, entry.val);
				if (error) invalid.push(error);
			}
			return invalid;
		},

		filter(predicate: (row: TRow) => boolean): TRow[] {
			const rows: TRow[] = [];
			for (const [key, entry] of ykv.entries()) {
				const { data, error } = parseRow(key, entry.val);
				if (!error && predicate(data)) rows.push(data);
			}
			return rows;
		},

		find(predicate: (row: TRow) => boolean): TRow | undefined {
			for (const [key, entry] of ykv.entries()) {
				const { data, error } = parseRow(key, entry.val);
				if (!error && predicate(data)) return data;
			}
			return undefined;
		},

		async bulkDelete(
			ids: string[],
			options?: {
				chunkSize?: number;
				onProgress?: (percent: number) => void;
			},
		): Promise<void> {
			const { chunkSize = 2500, onProgress } = options ?? {};
			const total = ids.length;

			for (let i = 0; i < total; i += chunkSize) {
				const chunk = ids.slice(i, i + chunkSize);
				ykv.bulkDelete(chunk);
				onProgress?.(Math.min((i + chunkSize) / total, 1));
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		},

		clear(): void {
			const keys = Array.from(ykv.entries()).map(([k]) => k);
			ykv.bulkDelete(keys);
		},

		observe(
			callback: (changedIds: ReadonlySet<TRow['id']>, origin?: unknown) => void,
		): () => void {
			const handler: KvStoreChangeHandler<unknown> = (changes, origin) => {
				callback(new Set(changes.keys()) as ReadonlySet<TRow['id']>, origin);
			};

			ykv.observe(handler);
			return () => ykv.unobserve(handler);
		},

		count(): number {
			return ykv.size;
		},

		has(id: string): boolean {
			return ykv.has(id);
		},
	};
}
