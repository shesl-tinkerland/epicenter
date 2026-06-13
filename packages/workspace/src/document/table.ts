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
 * Errors produced when this binary should understand a stored row but cannot
 * parse it against the table's schema: a corrupt or unknown `_v` stamp at or
 * below the latest known version, failed validation, or a failed migration.
 *
 * Surfaced (alongside {@link TableNewerWriterError}) in `scan().nonconforming`
 * and by the point reads `get()` and `update()`. "Not found" on `get()` /
 * `update()` is *not* an error: it's a legitimate absence and is returned as
 * `data: null` instead.
 *
 * Every variant carries `row`: the raw stored value as it sits in the CRDT,
 * including the library-managed `_v` stamp. The conformance repair flow reads
 * it to rebuild a conforming row (coerce the fields that still fit, default
 * the rest) and write it back with `set()`.
 *
 * A row stamped *above* this binary's latest known version is not a parse
 * error: it is a {@link TableNewerWriterError}, a staleness signal that needs
 * an app update rather than a repair, and `set()` refuses it.
 */
export const TableParseError = defineErrors({
	/**
	 * The row's `_v` is a corrupt or non-numeric stamp, or a numeric stamp at
	 * or below the latest known version that matches no registered schema. A
	 * `_v` strictly above the latest known version is a
	 * {@link TableNewerWriterError} instead.
	 */
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
// TABLE NEWER-WRITER ERROR
// ════════════════════════════════════════════════════════════════════════════

/**
 * A row a newer binary owns: its `_v` is a number strictly above this binary's
 * latest known schema version.
 *
 * This is not a data-integrity failure; the row is presumably fine, this binary
 * is just too old to read it. It is not repairable here (the user needs an app
 * update), and `set()` refuses to clobber it for the same reason. Kept distinct
 * from {@link TableParseError} so the "this binary is stale" case is a type fact
 * every consumer can switch on, not a runtime comparison each caller re-derives.
 *
 * Carries `version` (the stored stamp), `latestVersion` (what this binary
 * knows), and the raw `row` so a UI can report exactly how far ahead it is.
 */
export const TableNewerWriterError = defineErrors({
	/** The row's `_v` is a number strictly above this binary's latest version. */
	NewerWriter: ({
		id,
		version,
		latestVersion,
		row,
	}: {
		id: string;
		version: number;
		latestVersion: number;
		row: unknown;
	}) => ({
		message: `Row '${id}' was written by a newer version of this app (schema version ${version}, this app knows ${latestVersion}). Update the app to read it.`,
		id,
		version,
		latestVersion,
		row,
	}),
});
export type TableNewerWriterError = InferErrors<typeof TableNewerWriterError>;

// ════════════════════════════════════════════════════════════════════════════
// TABLE UNREADABLE ERROR
// ════════════════════════════════════════════════════════════════════════════

/**
 * An encrypted entry present in storage that this binary holds no usable key
 * for: a key rotation that left this device behind, a missing key version, or
 * a corrupt ciphertext.
 *
 * Unlike the other read errors there is no row to parse and no raw value to
 * carry: the bytes never decrypted. It carries `id` and a human-readable
 * `reason` (for example `keyVersion=3 not in keyring [1, 2]`). Not repairable
 * here (the user needs the key), and `set()` refuses to clobber it for the
 * same reason it refuses a {@link TableNewerWriterError}.
 *
 * Surfaced in `scan().unreadable`, built from the store's
 * `unreadableEntries()` enumeration.
 */
export const TableUnreadableError = defineErrors({
	/** A stored encrypted entry that did not decrypt under the active keyring. */
	UnreadableRow: ({ id, reason }: { id: string; reason: string }) => ({
		message: `Row '${id}' is encrypted with a key this device does not have: ${reason}`,
		id,
		reason,
	}),
});
export type TableUnreadableError = InferErrors<typeof TableUnreadableError>;

// ════════════════════════════════════════════════════════════════════════════
// TABLE READ ERROR
// ════════════════════════════════════════════════════════════════════════════

/**
 * Every reason a read cannot resolve a stored entry to a conforming row: a
 * parse failure this binary should understand ({@link TableParseError}), a row
 * a newer binary owns ({@link TableNewerWriterError}), or an encrypted entry
 * this binary holds no usable key for ({@link TableUnreadableError}).
 *
 * Surfaced by `get()` and `update()`. These are exactly the three non-row
 * states `scan()` buckets; a point read fails with whichever one applies to
 * the requested id, while "absent" stays a non-error `Ok(null)`.
 */
export type TableReadError =
	| TableParseError
	| TableNewerWriterError
	| TableUnreadableError;

// ════════════════════════════════════════════════════════════════════════════
// TABLE WRITE ERROR
// ════════════════════════════════════════════════════════════════════════════

/**
 * Errors produced when a write is refused before touching storage.
 *
 * Surfaced by `set()`. Whole-row writes stamp this binary's latest `_v` and
 * always win local LWW (the monotonic clock guarantees a fresh timestamp), so
 * a stale or keyless binary writing over a row it cannot read would silently
 * destroy data on every synced device. The guard refuses instead, for the two
 * states where the stored row exists but this binary cannot understand it:
 * a newer schema version ({@link TableNewerWriterError}) or an encrypted blob
 * with no usable key ({@link TableUnreadableError}).
 *
 * `bulkSet()` and `clear()` report the same refusals as
 * `{ refused: TableWriteError[] }` rather than an error: partial success is
 * their expected outcome, not a failure of the operation. Carrying the full
 * error (version or reason) lets an import banner say what it skipped and why.
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
	/** The stored row is an encrypted blob this binary holds no usable key for. */
	UnreadableRefusal: ({ id, reason }: { id: string; reason: string }) => ({
		message: `Row '${id}' is encrypted with a key this device does not have, so it cannot be overwritten: ${reason}`,
		id,
		reason,
	}),
});
export type TableWriteError = InferErrors<typeof TableWriteError>;

// ════════════════════════════════════════════════════════════════════════════
// TABLE SCAN
// ════════════════════════════════════════════════════════════════════════════

/**
 * The result of a single classified table read: every stored entry resolved
 * into exactly one of four mutually exclusive, collectively exhaustive states.
 * The bucket lengths sum to `storedCount()`, so no read can silently drop data.
 *
 * - `rows`: entries that parse and validate to the latest schema. The payload
 *   almost every caller wants; `scan().rows` replaces the old `getAllValid()`,
 *   but now the three issue buckets ride along in the same return value instead
 *   of being silently skipped.
 * - `nonconforming`: entries this binary should understand but cannot parse
 *   (failed validation, failed migration, or a corrupt `_v` stamp at or below
 *   the latest known version), classified as {@link TableParseError}. Each
 *   carries the raw stored value so a repair flow can rebuild it via `set()`.
 * - `newerWriter`: entries stamped by a schema version above this binary's
 *   latest, classified as {@link TableNewerWriterError}. Not repairable here;
 *   the user needs an app update, and `set()` refuses them.
 * - `unreadable`: encrypted entries this binary holds no usable key for,
 *   classified as {@link TableUnreadableError}. No row exists to parse.
 */
export type TableScan<TRow> = {
	/** Entries that parse and validate to the latest schema. */
	rows: TRow[];
	/** Entries this binary should understand but cannot parse. */
	nonconforming: TableParseError[];
	/** Entries stamped by a newer schema version than this binary knows. */
	newerWriter: TableNewerWriterError[];
	/** Encrypted entries this binary holds no usable key for. */
	unreadable: TableUnreadableError[];
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

	/**
	 * Point read by id. O(1). Returns `Ok(null)` for a row that is absent, and
	 * `Err(TableReadError)` for a stored entry this binary cannot resolve to a
	 * row (a parse failure or a newer-writer row).
	 */
	get(id: string): Result<TRow | null, TableReadError>;
	/**
	 * The one O(n) classified read: walk every stored entry, resolve each into
	 * one of four buckets, and return them grouped. `scan().rows` is the conforming
	 * payload; the three issue buckets ride along so no read silently drops data.
	 * Pull-based; recompute on the `observe()` signal. See {@link TableScan}.
	 */
	scan(): TableScan<TRow>;
	/**
	 * Find the first conforming row matching the predicate, short-circuiting at
	 * the first match. Unlike `scan().rows.find(...)` this stops scanning once it
	 * hits a match and never builds the issue buckets. The `Valid` in the name is
	 * honest: it can only match rows it can parse.
	 */
	findValid(predicate: (row: TRow) => boolean): TRow | undefined;
	observe(
		callback: (changedIds: ReadonlySet<TRow['id']>, origin?: unknown) => void,
	): () => void;
	/**
	 * Number of observer-confirmed stored entries. O(1). Counts every stored
	 * entry across all four read states: conforming rows, nonconforming rows
	 * that `scan().rows` excludes, newer-writer rows, and (on encrypted stores)
	 * undecryptable entries. May lag writes made inside an open transaction.
	 * Because it counts all four states, it reconciles exactly:
	 * `storedCount() === scan.rows.length + scan.nonconforming.length +
	 * scan.newerWriter.length + scan.unreadable.length`. For an "N items" badge
	 * next to a list, use `scan().rows.length` instead.
	 */
	storedCount(): number;
	has(id: string): boolean;
};

export type Table<
	TRow extends BaseRow,
	TVersions extends readonly VersionedColumns[] = readonly VersionedColumns[],
> = ReadonlyTable<TRow, TVersions> & {
	/**
	 * Whole-row write. Stamps this binary's latest `_v` and replaces the
	 * stored row. Refuses with `NewerWriterRefusal` when the stored row was
	 * stamped by a newer schema version than this binary knows, and with
	 * `UnreadableRefusal` when the stored row is an encrypted blob this binary
	 * holds no key for; in both cases the stored row is left untouched (the
	 * write would clobber a row this binary cannot read).
	 */
	set(row: TRow): Result<void, TableWriteError>;
	/**
	 * Chunked whole-row import. Rows whose stored slot this binary cannot read
	 * (a newer schema version or an undecryptable blob) are skipped per chunk at
	 * write time and reported in `refused` as `TableWriteError`; everything else
	 * is written. `onProgress` percent runs over the input length, including
	 * refused rows.
	 */
	bulkSet(
		rows: TRow[],
		options?: {
			chunkSize?: number;
			onProgress?: (percent: number) => void;
		},
	): Promise<{ refused: TableWriteError[] }>;
	update(
		id: string,
		partial: Partial<Omit<TRow, 'id'>>,
	): Result<TRow | null, TableReadError>;
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
	 * Delete every row this binary can claim to understand. Rows it cannot read,
	 * a newer schema version or an undecryptable blob, are skipped and reported
	 * in `refused`: `clear()` is bulk-blind, and a stale or keyless binary must
	 * not mass-destroy rows it cannot read. Use `delete(id)` to remove a
	 * specific such row.
	 */
	clear(): { refused: TableWriteError[] };
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
	 *
	 * Classifies the failure where the version set is in scope: a `_v` strictly
	 * above the latest known version is a {@link TableNewerWriterError} (this
	 * binary is stale); everything else this binary should understand but
	 * cannot is a {@link TableParseError}. It never produces a
	 * {@link TableUnreadableError}: that state comes from the store (a row that
	 * never decrypted), not from parsing a decrypted value, so the parse walk's
	 * error is the narrower union that `scan()` switches over exhaustively.
	 */
	function parseRow(
		id: string,
		input: unknown,
	): Result<TRow, TableParseError | TableNewerWriterError> {
		const stored: Record<string, unknown> = {
			...(input as Record<string, unknown>),
			id,
		};
		const version = stored._v;
		if (typeof version === 'number' && version > versions.length) {
			return TableNewerWriterError.NewerWriter({
				id,
				version,
				latestVersion: versions.length,
				row: stored,
			});
		}
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

		get(id: string): Result<TRow | null, TableReadError> {
			// An undecryptable entry reads as `undefined` from `ykv.get`, the same
			// as a truly absent one. Probe first so a present-but-unreadable row is
			// reported as `UnreadableRow`, not silently treated as absent.
			const reason = ykv.unreadableReason(id);
			if (reason !== undefined) {
				return TableUnreadableError.UnreadableRow({ id, reason });
			}
			const raw = ykv.get(id);
			if (raw === undefined) return Ok(null);
			return parseRow(id, raw);
		},

		scan(): TableScan<TRow> {
			const rows: TRow[] = [];
			const nonconforming: TableParseError[] = [];
			const newerWriter: TableNewerWriterError[] = [];
			for (const [key, entry] of ykv.entries()) {
				const { data, error } = parseRow(key, entry.val);
				if (!error) {
					rows.push(data);
					continue;
				}
				// parseRow already classified the failure; group by name.
				switch (error.name) {
					case 'NewerWriter':
						newerWriter.push(error);
						break;
					case 'UnknownVersion':
					case 'ValidationFailed':
					case 'MigrationFailed':
						nonconforming.push(error);
						break;
					default:
						error satisfies never;
				}
			}
			// The fourth bucket comes from the store, not the parse walk: encrypted
			// entries `entries()` skipped because they never decrypted.
			const unreadable: TableUnreadableError[] = [];
			for (const { key, reason } of ykv.unreadableEntries()) {
				unreadable.push(
					TableUnreadableError.UnreadableRow({ id: key, reason }).error,
				);
			}
			return { rows, nonconforming, newerWriter, unreadable };
		},

		findValid(predicate: (row: TRow) => boolean): TRow | undefined {
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

		storedCount(): number {
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
	 * This covers only the newer-writer half of the guard. On encrypted stores
	 * an undecryptable entry reads back as `undefined` here, indistinguishable
	 * from absent; the undecryptable case is caught separately by
	 * `ykv.unreadableReason` in {@link writeRefusal}.
	 */
	const newerStoredVersion = (val: unknown): number | undefined => {
		if (typeof val !== 'object' || val === null) return undefined;
		const version = (val as Record<string, unknown>)._v;
		return typeof version === 'number' && version > latestVersion
			? version
			: undefined;
	};

	/**
	 * The reason a whole-row write over `id` must be refused, or `undefined`
	 * when the slot is safe to overwrite (absent, conforming, or a repairable
	 * nonconforming row). Refuses the two states whose stored row exists but
	 * this binary cannot read: an undecryptable blob (`UnreadableRefusal`) and a
	 * newer-stamped row (`NewerWriterRefusal`). Checks the unreadable case first
	 * because on an encrypted store such a row reads back as `undefined`, the
	 * same as absent, so the version read alone cannot tell them apart.
	 */
	const writeRefusal = (id: string): TableWriteError | undefined => {
		const reason = ykv.unreadableReason(id);
		if (reason !== undefined) {
			return TableWriteError.UnreadableRefusal({ id, reason }).error;
		}
		const storedVersion = newerStoredVersion(ykv.get(id));
		if (storedVersion !== undefined) {
			return TableWriteError.NewerWriterRefusal({
				id,
				storedVersion,
				latestVersion,
			}).error;
		}
		return undefined;
	};

	return {
		...readonly,

		set(row: TRow): Result<void, TableWriteError> {
			const refusal = writeRefusal(row.id);
			if (refusal !== undefined) return Err(refusal);
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
		): Promise<{ refused: TableWriteError[] }> {
			const refused: TableWriteError[] = [];
			const total = rows.length;
			for (let i = 0; i < total; i += chunkSize) {
				const chunk = rows.slice(i, i + chunkSize);
				// Guard per chunk at write time, not once up front: the awaited
				// yield below lets a remote sync land a newer-stamped or newly
				// unreadable row for a later chunk's id mid-import.
				const writable: TRow[] = [];
				for (const row of chunk) {
					const refusal = writeRefusal(row.id);
					if (refusal !== undefined) {
						refused.push(refusal);
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
		): Result<TRow | null, TableReadError> {
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

		clear(): { refused: TableWriteError[] } {
			const refused: TableWriteError[] = [];
			const toDelete: string[] = [];
			for (const [key, entry] of ykv.entries()) {
				const storedVersion = newerStoredVersion(entry.val);
				if (storedVersion !== undefined) {
					refused.push(
						TableWriteError.NewerWriterRefusal({
							id: key,
							storedVersion,
							latestVersion,
						}).error,
					);
				} else {
					toDelete.push(key);
				}
			}
			// Undecryptable entries never appear in `entries()`, so the loop above
			// neither deletes nor reports them. Surface them as refusals so clear()
			// leaves no stored entry silently behind.
			for (const { key, reason } of ykv.unreadableEntries()) {
				refused.push(
					TableWriteError.UnreadableRefusal({ id: key, reason }).error,
				);
			}
			ykv.bulkDelete(toDelete);
			return { refused };
		},
	};
}
