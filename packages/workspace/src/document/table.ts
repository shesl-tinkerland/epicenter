/**
 * Table definition types and the `createTable` / `createReadonlyTable`
 * builders. `createWorkspace` (in `./workspace.ts`) consumes these to mount
 * tables onto a workspace root, applying encryption when a keyring is
 * provided.
 *
 * This file also keeps `attachTable` as an internal helper used by
 * package-local benchmarks and the create-table test. It is intentionally
 * NOT exported from the package barrel: public callers go through
 * `createWorkspace`.
 *
 * The library owns `_v` end-to-end: stamped on every write, stripped from
 * every read, refused as a column key at compile time. Users define columns
 * and (for multi-version tables) one migrate function. The user-facing row
 * type contains only the user's columns.
 */

import { type Static, type TObject, type TSchema, Type } from 'typebox';
import { Value } from 'typebox/value';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type * as Y from 'yjs';
import { TableKey } from './keys';
import {
	type KvStoreChangeHandler,
	type ObservableKvStore,
	YKeyValueLww,
	type YKeyValueLwwEntry,
} from './y-keyvalue/index';

// ════════════════════════════════════════════════════════════════════════════
// TABLE PARSE ERROR
// ════════════════════════════════════════════════════════════════════════════

/**
 * Errors produced when parsing stored rows against a table's schema.
 *
 * Surfaced by `get()`, `getAll()`, `getAllValid()`, `getAllInvalid()`,
 * `filter()`, `find()`, `conformance()`, and `update()`. "Not found" on
 * `get()` / `update()` is *not* an error: it's a legitimate absence and is
 * returned as `data: null` instead.
 *
 * Every variant carries `row`: the raw stored value as it sits in the CRDT,
 * including the library-managed `_v` stamp. The conformance repair flow reads
 * it to rebuild a conforming row (coerce the fields that still fit, default
 * the rest) and write it back with `set()`. The one cause it cannot repair is
 * a `newerWriter` row (an `UnknownVersion` stamped above this binary's latest
 * version): that needs an app update, and `set()` refuses it anyway.
 */
export const TableParseError = defineErrors({
	/** The row's `_v` did not match any registered schema version. */
	UnknownVersion: ({
		id,
		version,
		row,
	}: {
		id: string;
		version: unknown;
		row: unknown;
	}) => ({
		message: `Row '${id}' has unknown _v value: ${String(version)}`,
		id,
		version,
		row,
	}),
	/** TypeBox `Value.Check` rejected the row against the matched version. */
	ValidationFailed: ({
		id,
		errors,
		row,
	}: {
		id: string;
		errors: readonly { path: string; message: string }[];
		row: unknown;
	}) => ({
		message: `Row '${id}' failed schema validation: ${errors
			.map((e) => `${e.path}: ${e.message}`)
			.join('; ')}`,
		id,
		errors,
		row,
	}),
	/** The migration function threw while upgrading a valid-at-parse-time row. */
	MigrationFailed: ({
		id,
		cause,
		row,
	}: {
		id: string;
		cause: unknown;
		row: unknown;
	}) => ({
		message: `Row '${id}' could not be migrated: ${extractErrorMessage(cause)}`,
		id,
		cause,
		row,
	}),
});
export type TableParseError = InferErrors<typeof TableParseError>;

// ════════════════════════════════════════════════════════════════════════════
// TABLE WRITE ERROR
// ════════════════════════════════════════════════════════════════════════════

/**
 * Errors produced when a write is refused before touching storage.
 *
 * Surfaced by `set()`. Whole-row writes stamp this binary's latest `_v` and
 * always win local LWW (the monotonic clock guarantees a fresh timestamp), so
 * a stale binary writing over a newer-schema row would silently destroy
 * newer-only columns on every synced device. The guard refuses instead.
 *
 * `bulkSet()` and `clear()` report the same refusals as `{ refused: string[] }`
 * rather than an error: partial success is their expected outcome, not a
 * failure of the operation.
 */
export const TableWriteError = defineErrors({
	/** The stored row's `_v` exceeds this binary's latest known version. */
	NewerWriterRefusal: ({
		id,
		storedVersion,
		latestVersion,
	}: {
		id: string;
		storedVersion: number;
		latestVersion: number;
	}) => ({
		message: `Row '${id}' was written by a newer version of this app (schema version ${storedVersion}, this app knows ${latestVersion}). Update the app to edit it.`,
		id,
		storedVersion,
		latestVersion,
	}),
});
export type TableWriteError = InferErrors<typeof TableWriteError>;

// ════════════════════════════════════════════════════════════════════════════
// TABLE CONFORMANCE
// ════════════════════════════════════════════════════════════════════════════

/**
 * Per-table conformance snapshot: every stored row classified by what the
 * read path already computes in `parseRow`. Nothing here is new information;
 * `getAllValid()` silently skips exactly the rows the two queues surface.
 *
 * Two causes, two queues:
 * - `nonconforming`: rows this binary should understand but cannot parse
 *   (failed validation, failed migration, or a corrupt `_v` stamp at or
 *   below the latest known version). The repair tool's input: app code
 *   iterates `getAllInvalid()` and fixes via `set()` or discards via
 *   `delete()`.
 * - `newerWriter`: rows stamped by a schema version above this binary's
 *   latest. Not repairable here; the user needs an app update. `set()`
 *   refuses these rows for the same reason (see {@link TableWriteError}).
 */
export type TableConformance = {
	/** Count of rows that parse to the latest schema. */
	valid: number;
	/** Rows this binary should understand but cannot parse. */
	nonconforming: TableParseError[];
	/** Rows stamped by a newer schema version than this binary knows. */
	newerWriter: TableParseError[];
};

// ════════════════════════════════════════════════════════════════════════════
// ROW TYPE
// ════════════════════════════════════════════════════════════════════════════

/**
 * The minimum shape every table row must satisfy.
 *
 * `_v` is library state and lives only on the stored payload, never on the
 * user-facing row type. `BaseRow` carries only `id`.
 */
export type BaseRow = { id: string };

// ════════════════════════════════════════════════════════════════════════════
// COLUMN RECORD TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * A column record. Every table version is a `Record<string, TSchema>` with
 * a string-ish `id` column. `_v` is library-managed and refused as a column
 * key at compile time via `defineTable`'s parameter constraint.
 *
 * `FlatJsonTSchema` (applied in `defineTable`'s parameter type) enforces
 * every column maps 1:1 to a SQLite column.
 */
export type VersionedColumns = {
	id: TSchema;
	[key: string]: TSchema;
};

/** Convert a column record to its row static type. */
export type RowOf<TCols extends Record<string, TSchema>> = {
	[K in keyof TCols]: Static<TCols[K]>;
};

export type LastVersion<TVersions extends readonly VersionedColumns[]> =
	TVersions extends readonly [...infer _, infer L]
		? L extends VersionedColumns
			? L
			: TVersions[number]
		: TVersions[number];

// ════════════════════════════════════════════════════════════════════════════
// MIGRATE INPUT TYPE
// ════════════════════════════════════════════════════════════════════════════

/**
 * Bounded type-level addition: returns `N + 1` as a literal.
 *
 * Used to map tuple positions (0-indexed) to version numbers (1-indexed) for
 * the migrate function's input discriminator.
 */
type IncrementVersion<
	N extends number,
	Acc extends unknown[] = [],
> = Acc['length'] extends N
	? [...Acc, unknown]['length']
	: IncrementVersion<N, [...Acc, unknown]>;

/**
 * Migrate input: walks the versions tuple and accumulates `{ value, version }`
 * pairs where `version = position + 1`. Distributing this as a union gives
 * TypeScript discriminated narrowing on `switch (version)` in the migrate fn.
 *
 * For `defineTable(v1Cols, v2Cols)`:
 *   MigrateInput = { value: RowOf<v1Cols>; version: 1 }
 *                | { value: RowOf<v2Cols>; version: 2 }
 */
export type MigrateInput<
	TVersions extends readonly VersionedColumns[],
	Acc extends readonly unknown[] = [],
> = TVersions extends readonly [
	infer Head,
	...infer Rest extends readonly VersionedColumns[],
]
	? Head extends VersionedColumns
		? MigrateInput<
				Rest,
				readonly [
					...Acc,
					{
						value: RowOf<Head>;
						version: IncrementVersion<Acc['length'] & number>;
					},
				]
			>
		: never
	: Acc[number];

// ════════════════════════════════════════════════════════════════════════════
// TABLE DEFINITION
// ════════════════════════════════════════════════════════════════════════════

/**
 * A table definition created by `defineTable(cols)` (single version) or
 * `defineTable(v1, v2, ...).migrate(fn)` (multi-version).
 *
 * For per-row content (rich text, long-form body), keep the row lean (ids and
 * metadata) and derive the content-doc guid in app code. Browser runtimes can
 * pair the table with a `createDisposableCache(builder)` keyed by row id; daemon
 * projections can open one content doc for one row and destroy it after reading.
 * The table schema does not declare or store body docs.
 */
export type TableDefinition<
	TVersions extends readonly VersionedColumns[] = readonly VersionedColumns[],
> = {
	/** The original variadic versions, in declaration order. */
	versions: TVersions;
	/**
	 * Latest version's row schema as a TypeBox `TObject` (user-facing; no `_v`).
	 *
	 * Use as the runtime schema for full-row action inputs:
	 * ```ts
	 * defineMutation({ input: tables.notes.schema, handler: tables.notes.set });
	 * ```
	 *
	 * Pluck individual column schemas via `.properties.X` for narrow inputs:
	 * ```ts
	 * Type.Object({
	 *   id:    tables.notes.schema.properties.id,
	 *   title: tables.notes.schema.properties.title,
	 * })
	 * ```
	 *
	 * The SQLite DDL generator and markdown materializer both read this field.
	 */
	schema: TObject<LastVersion<TVersions>>;
	/** Upgrade any stored version to the current row in one step. */
	migrate: (input: MigrateInput<TVersions>) => RowOf<LastVersion<TVersions>>;
};

/**
 * Extract the user-facing row type from a TableDefinition.
 *
 * Intersected with `BaseRow` so that `id: string` is guaranteed even when
 * the generic widens (e.g. `TableDefinition<any>` in `TableDefinitions`).
 */
export type InferTableRow<T> =
	T extends TableDefinition<infer TVersions>
		? TVersions extends readonly VersionedColumns[]
			? RowOf<LastVersion<TVersions>> & BaseRow
			: BaseRow
		: never;

/** Map of table definitions (uses `any` to allow variance in generic parameters). */
export type TableDefinitions = Record<
	string,
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly map type
	TableDefinition<any>
>;

// ════════════════════════════════════════════════════════════════════════════
// createTableDefinition
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build a `TableDefinition` from a list of versions and the migrate function.
 * Called by `defineTable`; exposed for future codegen / encryption helpers
 * that need to assemble a definition directly.
 *
 * @internal
 */
export function createTableDefinition<
	TVersions extends readonly VersionedColumns[],
>(
	versions: TVersions,
	migrate: (input: unknown) => RowOf<LastVersion<TVersions>>,
): TableDefinition<TVersions> {
	const latestColumns = versions[versions.length - 1] as LastVersion<TVersions>;
	return {
		versions,
		schema: Type.Object(latestColumns),
		migrate: migrate as TableDefinition<TVersions>['migrate'],
	};
}

// ════════════════════════════════════════════════════════════════════════════
// TABLE HANDLE TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * Type-safe read-only runtime handle for a single workspace table.
 *
 * Mirrors `schema` (the latest version's row TObject) from the definition for
 * ergonomics; the underlying `definition` stays exposed for introspection.
 */
export type ReadonlyTable<
	TRow extends BaseRow,
	TVersions extends readonly VersionedColumns[] = readonly VersionedColumns[],
> = {
	/** The table name (the Y.Array key this table is bound to). */
	name: string;

	/** The underlying `TableDefinition`. */
	definition: TableDefinition<TVersions>;

	/**
	 * Latest version's row schema (mirrored from `definition.schema`).
	 *
	 * Use as the runtime schema for full-row action inputs, or pluck
	 * individual column schemas via `.properties.X` for narrow inputs.
	 * See `TableDefinition.schema` JSDoc for examples.
	 */
	schema: TObject<LastVersion<TVersions>>;

	get(id: string): Result<TRow | null, TableParseError>;
	getAll(): Array<Result<TRow, TableParseError>>;
	getAllValid(): TRow[];
	getAllInvalid(): TableParseError[];
	filter(predicate: (row: TRow) => boolean): TRow[];
	find(predicate: (row: TRow) => boolean): TRow | undefined;
	observe(
		callback: (changedIds: ReadonlySet<TRow['id']>, origin?: unknown) => void,
	): () => void;
	/**
	 * Classify every stored row: a full scan plus validation, same cost as
	 * `getAllValid()`. Pull-based; recompute on the `observe()` signal.
	 * See {@link TableConformance} for the two queues and their meaning.
	 */
	conformance(): TableConformance;
	/**
	 * Number of observer-confirmed stored entries. O(1). Includes
	 * nonconforming rows that `getAllValid()` hides, may lag writes made
	 * inside an open transaction, and encrypted stores subtract
	 * undecryptable entries. For an "N items" badge next to a filtered
	 * list, use `conformance().valid` instead.
	 */
	count(): number;
	has(id: string): boolean;
};

export type Table<
	TRow extends BaseRow,
	TVersions extends readonly VersionedColumns[] = readonly VersionedColumns[],
> = ReadonlyTable<TRow, TVersions> & {
	/**
	 * Whole-row write. Stamps this binary's latest `_v` and replaces the
	 * stored row. Refuses with `NewerWriterRefusal` when the stored row was
	 * stamped by a newer schema version than this binary knows; the stored
	 * row is left untouched and the caller should prompt for an app update.
	 */
	set(row: TRow): Result<void, TableWriteError>;
	/**
	 * Chunked whole-row import. Rows stamped by a newer schema version are
	 * skipped per chunk at write time and reported in `refused`; everything
	 * else is written. `onProgress` percent runs over the input length,
	 * including refused rows.
	 */
	bulkSet(
		rows: TRow[],
		options?: {
			chunkSize?: number;
			onProgress?: (percent: number) => void;
		},
	): Promise<{ refused: string[] }>;
	update(
		id: string,
		partial: Partial<Omit<TRow, 'id'>>,
	): Result<TRow | null, TableParseError>;
	/**
	 * Delete one row by id. Deliberately unguarded: deletion intent is
	 * shape-independent, so newer-stamped rows are deletable too.
	 */
	delete(id: string): void;
	bulkDelete(
		ids: string[],
		options?: {
			chunkSize?: number;
			onProgress?: (percent: number) => void;
		},
	): Promise<void>;
	/**
	 * Delete every row this binary can claim to understand. Rows stamped by
	 * a newer schema version are skipped and reported in `refused`: `clear()`
	 * is bulk-blind, and a stale binary must not mass-destroy rows it cannot
	 * read. Use `delete(id)` to remove a specific newer-stamped row.
	 */
	clear(): { refused: string[] };
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

// ════════════════════════════════════════════════════════════════════════════
// INTERNAL: attach (used by package-local benchmarks + tests; NOT exported
// from the public barrel: public callers go through `createWorkspace`)
// ════════════════════════════════════════════════════════════════════════════

export function attachTable<
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly
	TTableDefinition extends TableDefinition<any>,
>(
	ydoc: Y.Doc,
	name: string,
	definition: TTableDefinition,
): Table<InferTableRow<TTableDefinition>> {
	const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(TableKey(name));
	const ykv = new YKeyValueLww<unknown>(yarray);
	ydoc.once('destroy', () => ykv[Symbol.dispose]());
	return createTable(ykv, definition, name);
}

// ════════════════════════════════════════════════════════════════════════════
// createTable / createReadonlyTable
// ════════════════════════════════════════════════════════════════════════════

export function createReadonlyTable<
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly
	TTableDefinition extends TableDefinition<any>,
>(
	ykv: ObservableKvStore<unknown>,
	definition: TTableDefinition,
	name: string,
): ReadonlyTable<InferTableRow<TTableDefinition>> {
	type TRow = InferTableRow<TTableDefinition>;

	const versions = definition.versions as readonly VersionedColumns[];

	/**
	 * Per-version augmented schema (user columns + `_v: Literal(N)`), keyed
	 * by version number (1-indexed = tuple position + 1). Used to validate
	 * stored rows: storage carries `_v`, so we route on it before validating.
	 */
	const versionSchemas = new Map<number, TObject>();
	for (let i = 0; i < versions.length; i++) {
		const versionNumber = i + 1;
		const cols = versions[i]!;
		versionSchemas.set(
			versionNumber,
			Type.Object({ ...cols, _v: Type.Literal(versionNumber) }) as TObject,
		);
	}

	/**
	 * Parse a stored row value. Injects `id` into the input, routes by stored
	 * `_v` to the matching schema, validates, runs migrate, returns the
	 * user-facing row (no `_v`).
	 */
	function parseRow(id: string, input: unknown): Result<TRow, TableParseError> {
		const stored: Record<string, unknown> = {
			...(input as Record<string, unknown>),
			id,
		};
		const version = stored._v;
		const schema =
			typeof version === 'number' ? versionSchemas.get(version) : undefined;
		if (!schema) {
			return TableParseError.UnknownVersion({ id, version, row: stored });
		}
		if (!Value.Check(schema, stored)) {
			const errors = [...Value.Errors(schema, stored)].map((e) => ({
				path: e.instancePath,
				message: e.message,
			}));
			return TableParseError.ValidationFailed({ id, errors, row: stored });
		}
		try {
			// Strip `_v` from the value passed to migrate. The user's migrate fn
			// works in terms of the version's user-facing columns only.
			const { _v: _, ...value } = stored;
			const migrated = definition.migrate({
				value,
				version,
			} as Parameters<typeof definition.migrate>[0]) as TRow;
			return Ok(migrated);
		} catch (cause) {
			return TableParseError.MigrationFailed({ id, cause, row: stored });
		}
	}

	return {
		name,
		definition,
		schema: definition.schema,

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

		conformance(): TableConformance {
			let valid = 0;
			const nonconforming: TableParseError[] = [];
			const newerWriter: TableParseError[] = [];
			for (const [key, entry] of ykv.entries()) {
				const { error } = parseRow(key, entry.val);
				if (!error) {
					valid++;
				} else if (
					error.name === 'UnknownVersion' &&
					typeof error.version === 'number' &&
					error.version > versions.length
				) {
					newerWriter.push(error);
				} else {
					// ValidationFailed, MigrationFailed, and corrupt stamps
					// (UnknownVersion at or below the latest known version).
					nonconforming.push(error);
				}
			}
			return { valid, nonconforming, newerWriter };
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
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly
	TTableDefinition extends TableDefinition<any>,
>(
	ykv: ObservableKvStore<unknown>,
	definition: TTableDefinition,
	name: string,
): Table<InferTableRow<TTableDefinition>> {
	type TRow = InferTableRow<TTableDefinition>;
	const readonly = createReadonlyTable(ykv, definition, name);

	const latestVersion = definition.versions.length;
	/** Stamp the latest `_v` onto a row for storage. */
	const stamp = (row: TRow): Record<string, unknown> => ({
		...(row as Record<string, unknown>),
		_v: latestVersion,
	});

	/**
	 * The stored value's `_v` when it was stamped by a newer schema version
	 * than this binary knows, else undefined. Reads the raw stored value
	 * without parsing: corrupt values (non-object, missing or non-numeric
	 * `_v`) return undefined so the write proceeds and repairs them.
	 *
	 * The guard is local-knowledge only: it can only refuse over rows that
	 * are locally visible, and on encrypted stores an undecryptable entry
	 * reads as absent. Both residuals are recorded in the schema-conformance
	 * spec.
	 */
	const newerStoredVersion = (val: unknown): number | undefined => {
		if (typeof val !== 'object' || val === null) return undefined;
		const version = (val as Record<string, unknown>)._v;
		return typeof version === 'number' && version > latestVersion
			? version
			: undefined;
	};

	return {
		...readonly,

		set(row: TRow): Result<void, TableWriteError> {
			const storedVersion = newerStoredVersion(ykv.get(row.id));
			if (storedVersion !== undefined) {
				return TableWriteError.NewerWriterRefusal({
					id: row.id,
					storedVersion,
					latestVersion,
				});
			}
			ykv.set(row.id, stamp(row));
			return Ok(undefined);
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
		): Promise<{ refused: string[] }> {
			const refused: string[] = [];
			const total = rows.length;
			for (let i = 0; i < total; i += chunkSize) {
				const chunk = rows.slice(i, i + chunkSize);
				// Guard per chunk at write time, not once up front: the awaited
				// yield below lets a remote sync land a newer-stamped row for a
				// later chunk's id mid-import.
				const writable: TRow[] = [];
				for (const row of chunk) {
					if (newerStoredVersion(ykv.get(row.id)) !== undefined) {
						refused.push(row.id);
					} else {
						writable.push(row);
					}
				}
				if (writable.length > 0) {
					ykv.bulkSet(
						writable.map((row) => ({ key: row.id, val: stamp(row) })),
					);
				}
				onProgress?.(Math.min((i + chunkSize) / total, 1));
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
			return { refused };
		},

		update(
			id: string,
			partial: Partial<Omit<TRow, 'id'>>,
		): Result<TRow | null, TableParseError> {
			const { data: current, error } = readonly.get(id);
			if (error) return Err(error);
			if (current === null) return Ok(null);

			// `current` is already the latest-version user-facing row (get()
			// migrates on read), so merging with a partial keeps us in the
			// latest shape. Validate against the latest schema directly: no
			// need to stamp _v, route, and re-migrate just to write back.
			const merged = { ...current, ...partial, id } as TRow;
			if (!Value.Check(definition.schema, merged)) {
				const errors = [...Value.Errors(definition.schema, merged)].map(
					(e) => ({
						path: e.instancePath,
						message: e.message,
					}),
				);
				return TableParseError.ValidationFailed({ id, errors, row: merged });
			}
			ykv.set(merged.id, stamp(merged));
			return Ok(merged);
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

		clear(): { refused: string[] } {
			const refused: string[] = [];
			const toDelete: string[] = [];
			for (const [key, entry] of ykv.entries()) {
				if (newerStoredVersion(entry.val) !== undefined) {
					refused.push(key);
				} else {
					toDelete.push(key);
				}
			}
			ykv.bulkDelete(toDelete);
			return { refused };
		},
	};
}
