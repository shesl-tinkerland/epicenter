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
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { JsonObject } from 'wellcrafted/json';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type * as Y from 'yjs';
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
	TVersions extends
		readonly CombinedStandardSchema<BaseRow>[] = readonly CombinedStandardSchema<BaseRow>[],
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

/**
 * Type-safe read-only runtime handle for a single workspace table.
 *
 * Provides parsing, validated reads, queries, and observation. It intentionally
 * has no write methods.
 *
 * @typeParam TRow - The fully-typed row shape for this table (extends `{ id: string }`)
 */
export type ReadonlyTable<TRow extends BaseRow> = {
	/** The table name (the Y.Array key this table is bound to). */
	name: string;

	/**
	 * The underlying `TableDefinition` (schema + migration) this table was
	 * attached with. Exposed for consumers that need the raw schema: e.g.,
	 * the sqlite materializer generating DDL.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly: defineTable already constrains schemas
	definition: TableDefinition<any>;

	/**
	 * Parse unknown input against the table schema and migrate to the latest
	 * version.
	 *
	 * Injects `id` into the input before validation. Does not write to storage.
	 *
	 * @returns `Result<TRow, TableParseError>`:
	 *   - `data: TRow` when the input validates and migrates
	 *   - `error: TableParseError` on validation / migration failure
	 */
	parse(id: string, input: unknown): Result<TRow, TableParseError>;

	/**
	 * Get a single row by ID.
	 *
	 * @returns `Result<TRow | null, TableParseError>`:
	 *   - `data: TRow` when the row exists and validates
	 *   - `data: null` when no row exists at that id (not an error: legitimate absence)
	 *   - `error: TableParseError` when the stored row failed schema validation
	 */
	get(id: string): Result<TRow | null, TableParseError>;

	/** Get all rows with their validation outcome. */
	getAll(): Array<Result<TRow, TableParseError>>;

	/** Get all rows that pass schema validation. */
	getAllValid(): TRow[];

	/** Get all rows that fail schema validation. */
	getAllInvalid(): TableParseError[];

	/** Filter valid rows by predicate. */
	filter(predicate: (row: TRow) => boolean): TRow[];

	/** Find the first valid row matching a predicate. */
	find(predicate: (row: TRow) => boolean): TRow | undefined;

	/** Watch for row changes. */
	observe(
		callback: (changedIds: ReadonlySet<TRow['id']>, origin?: unknown) => void,
	): () => void;

	/** Get the total number of rows in the table. */
	count(): number;

	/** Check if a row exists by ID. */
	has(id: string): boolean;
};

export type Table<TRow extends BaseRow> = ReadonlyTable<TRow> & {
	/** Set a row (insert or replace). Always writes the full row. */
	set(row: TRow): void;

	/** Insert or replace many rows with chunked transactions and progress reporting. */
	bulkSet(
		rows: TRow[],
		options?: {
			chunkSize?: number;
			onProgress?: (percent: number) => void;
		},
	): Promise<void>;

	/**
	 * Partial update a row by ID.
	 *
	 * @returns `Result<TRow | null, TableParseError>`:
	 *   - `data: TRow` when the row existed, merged, and validated
	 *   - `data: null` when no row exists at that id (nothing to update)
	 *   - `error: TableParseError` when the current row is invalid, or the merged
	 *     row fails validation
	 */
	update(
		id: string,
		partial: Partial<Omit<TRow, 'id'>>,
	): Result<TRow | null, TableParseError>;

	/** Delete a single row by ID. */
	delete(id: string): void;

	/** Delete many rows by ID with chunked operations and progress reporting. */
	bulkDelete(
		ids: string[],
		options?: {
			chunkSize?: number;
			onProgress?: (percent: number) => void;
		},
	): Promise<void>;

	/** Delete all rows from the table. */
	clear(): void;
};

/** Map keyed by table name to Table for that table's row type. */
export type Tables<TTableDefinitions extends TableDefinitions> = {
	[K in keyof TTableDefinitions]: Table<InferTableRow<TTableDefinitions[K]>>;
};

export type ReadonlyTables<TTableDefinitions extends TableDefinitions> = {
	[K in keyof TTableDefinitions]: ReadonlyTable<
		InferTableRow<TTableDefinitions[K]>
	>;
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

export function attachReadonlyTable<
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly: defineTable already constrains schemas
	TTableDefinition extends TableDefinition<any>,
>(
	ydoc: Y.Doc,
	name: string,
	definition: TTableDefinition,
): ReadonlyTable<InferTableRow<TTableDefinition>> {
	const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(TableKey(name));
	const ykv = new YKeyValueLww<unknown>(yarray);
	ydoc.on('destroy', () => ykv.dispose());
	return createReadonlyTable(ykv, definition, name);
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

export function attachReadonlyTables<T extends TableDefinitions>(
	ydoc: Y.Doc,
	definitions: T,
): ReadonlyTables<T> {
	return Object.fromEntries(
		Object.entries(definitions).map(([name, def]) => [
			name,
			attachReadonlyTable(ydoc, name, def),
		]),
	) as ReadonlyTables<T>;
}

/**
 * Construct a ReadonlyTable from any `ObservableKvStore` and a TableDefinition.
 *
 * Exported so `@epicenter/workspace` can reuse the exact same helper logic
 * over its encrypted store wrapper.
 */
export function createReadonlyTable<
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly: defineTable already constrains schemas
	TTableDefinition extends TableDefinition<any>,
>(
	ykv: ObservableKvStore<unknown>,
	definition: TTableDefinition,
	name: string,
): ReadonlyTable<InferTableRow<TTableDefinition>> {
	type TRow = InferTableRow<TTableDefinition>;

	/**
	 * Parse and migrate a raw row value. Injects `id` into the input before
	 * validation. Returns `Result<TRow, TableParseError>`.
	 */
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

	return {
		name,
		definition,

		parse(id: string, input: unknown): Result<TRow, TableParseError> {
			return parseRow(id, input);
		},

		get(id: string): Result<TRow | null, TableParseError> {
			const raw = ykv.get(id);
			if (raw === undefined) return Ok(null);
			return parseRow(id, raw);
		},

		getAll(): Array<Result<TRow, TableParseError>> {
			const results: Array<Result<TRow, TableParseError>> = [];
			for (const [key, entry] of ykv.entries()) {
				results.push(parseRow(key, entry.val));
			}
			return results;
		},

		getAllValid(): TRow[] {
			const rows: TRow[] = [];
			for (const [key, entry] of ykv.entries()) {
				const { data, error } = parseRow(key, entry.val);
				if (!error) rows.push(data);
			}
			return rows;
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

export function createTable<
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly: defineTable already constrains schemas
	TTableDefinition extends TableDefinition<any>,
>(
	ykv: ObservableKvStore<unknown>,
	definition: TTableDefinition,
	name: string,
): Table<InferTableRow<TTableDefinition>> {
	type TRow = InferTableRow<TTableDefinition>;
	const readonly = createReadonlyTable(ykv, definition, name);

	return {
		...readonly,

		set(row: TRow): void {
			ykv.set(row.id, row);
		},

		async bulkSet(
			rows: TRow[],
			{
				chunkSize = 1000,
				onProgress,
			}: {
				chunkSize?: number;
				onProgress?: (percent: number) => void;
			} = {},
		): Promise<void> {
			const total = rows.length;

			for (let i = 0; i < total; i += chunkSize) {
				const chunk = rows.slice(i, i + chunkSize);
				ykv.bulkSet(chunk.map((row) => ({ key: row.id, val: row })));
				onProgress?.(Math.min((i + chunkSize) / total, 1));
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		},

		update(
			id: string,
			partial: Partial<Omit<TRow, 'id'>>,
		): Result<TRow | null, TableParseError> {
			const { data: current, error: currentError } = readonly.get(id);
			if (currentError) return Err(currentError);
			if (current === null) return Ok(null);

			const merged = { ...current, ...partial, id };
			const { data: validated, error: mergedError } = readonly.parse(id, merged);
			if (mergedError) return Err(mergedError);

			ykv.set(validated.id, validated);
			return Ok(validated);
		},

		delete(id: string): void {
			ykv.delete(id);
		},

		async bulkDelete(
			ids: string[],
			{
				chunkSize = 2500,
				onProgress,
			}: {
				chunkSize?: number;
				onProgress?: (percent: number) => void;
			} = {},
		): Promise<void> {
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
	};
}
