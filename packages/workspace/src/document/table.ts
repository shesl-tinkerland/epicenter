/**
 * Table definition types and the `createTable` / `createReadonlyTable`
 * builders. `createWorkspace` (in `./workspace.ts`) consumes these to mount
 * tables onto a workspace root.
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

import type { InstantString } from '@epicenter/field';
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
	 * The row's `_v` is no schema this binary has: a non-numeric, fractional,
	 * zero, or negative stamp, or a whole number at or below the latest known
	 * version that matches no registered schema. A whole number strictly above
	 * the latest known version is a {@link TableNewerWriterError} instead.
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
 * A row a newer binary owns: its `_v` is a whole number strictly above this
 * binary's latest known schema version.
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
	/** The row's `_v` is a whole number strictly above this binary's latest. */
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
// TABLE READ ERROR
// ════════════════════════════════════════════════════════════════════════════

/**
 * Every reason a read cannot resolve a stored entry to a conforming row: a
 * parse failure this binary should understand ({@link TableParseError}) or a
 * row a newer binary owns ({@link TableNewerWriterError}).
 *
 * Surfaced by `get()` and `update()`. These are exactly the two non-row
 * states `scan()` buckets; a point read fails with whichever one applies to
 * the requested id, while "absent" stays a non-error `Ok(null)`.
 */
export type TableReadError = TableParseError | TableNewerWriterError;

// ════════════════════════════════════════════════════════════════════════════
// TABLE WRITE ERROR
// ════════════════════════════════════════════════════════════════════════════

/**
 * Errors produced when a write is refused before touching storage.
 *
 * Surfaced by `set()`. Whole-row writes stamp this binary's latest `_v` and
 * always win local LWW (the monotonic clock guarantees a fresh timestamp), so
 * a stale binary writing over a newer-owned row would silently destroy data on
 * every synced node. The guard refuses rows stamped by a newer schema
 * version ({@link TableNewerWriterError}).
 *
 * `bulkSet()` and `clear()` report the same refusals as
 * `{ refused: TableWriteError[] }` rather than an error: partial success is
 * their expected outcome, not a failure of the operation.
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
// TABLE SCAN
// ════════════════════════════════════════════════════════════════════════════

/**
 * The result of a single classified table read: every stored entry resolved
 * into exactly one of three mutually exclusive, collectively exhaustive states.
 * The bucket lengths sum to `storedCount()`, so no read can silently drop data.
 *
 * - `rows`: entries that parse and validate to the latest schema. The payload
 *   almost every caller wants, with the issue buckets riding along in the
 *   same return value instead of being silently skipped.
 * - `nonconforming`: entries this binary should understand but cannot parse
 *   (failed validation, failed migration, or a corrupt `_v` stamp at or below
 *   the latest known version), classified as {@link TableParseError}. Each
 *   carries the raw stored value so a repair flow can rebuild it via `set()`.
 * - `newerWriter`: entries stamped by a schema version above this binary's
 *   latest, classified as {@link TableNewerWriterError}. Not repairable here;
 *   the user needs an app update, and `set()` refuses them.
 */
export type TableScan<TRow> = {
	/** Entries that parse and validate to the latest schema. */
	rows: TRow[];
	/** Entries this binary should understand but cannot parse. */
	nonconforming: TableParseError[];
	/** Entries stamped by a newer schema version than this binary knows. */
	newerWriter: TableNewerWriterError[];
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
 * metadata) and declare child docs with `.docs({ body: attachLayout })`.
 * The table schema never stores body docs; `defineWorkspace(...).connect(connection)`
 * derives each content-doc guid from the workspace id, table name, row id, and
 * child-doc field.
 */
/**
 * A child-doc's CRDT shape: a pure function of a `Y.Doc` that owns a
 * collaborative body's layout and writer policy (e.g. `attachRichText`,
 * `attachPlainText`). Carries no connection, so the declaration is isomorphic;
 * `defineWorkspace(...).connect(connection)` marries it to a connection at runtime.
 */
export type ChildDocLayout = (ydoc: Y.Doc) => object;

/**
 * The row's `InstantString` columns, by name: every non-`id` column whose value
 * (ignoring `null`) is an {@link InstantString}. The valid targets for `touch`.
 *
 * Admits `updatedAt: InstantString` and nullable `deletedAt: InstantString | null`;
 * excludes a `DateTimeString` column (a different brand: user-authored, not a
 * machine instant) and any non-time column. Collapses to `never` for a table
 * with no instant column, so `touch` simply isn't offered there.
 */
type InstantColumnKey<TRow extends BaseRow> = {
	[K in keyof Omit<TRow, 'id'>]-?: NonNullable<TRow[K]> extends InstantString
		? K
		: never;
}[keyof Omit<TRow, 'id'>] &
	string;

/**
 * One stored child-doc declaration: a bare {@link ChildDocLayout} (no per-field
 * policy), or a layout paired with optional policy. The object form is the
 * single extension point for future per-field concerns (e.g. debounce, a
 * per-field `gcTime`); adding a key never breaks the bare form.
 *
 * `touch` names a row column to stamp with `InstantString.now()` on a LOCAL edit
 * to the body doc (Yjs `tx.local`), never on synced or hydrated updates, so body
 * edits bump recency without a custom observer in every table. It is stored as a
 * plain column-name `string`: the `InstantString`-column constraint is enforced
 * at the `.docs(...)` call site (see {@link ChildDocDeclarationInput}, where the
 * row type is still in scope) and then widened to `string` for storage, so the
 * row type never has to thread through {@link TableDefinition}.
 */
export type ChildDocDeclaration =
	| ChildDocLayout
	| {
			layout: ChildDocLayout;
			touch?: string;
	  };

/**
 * A map of stored child-doc declarations, keyed by field name. The field name
 * becomes the guid's `field` segment, so each row owns one derived child doc per
 * declared name (1:1). Declared on a table via {@link DeclarableTableDefinition.docs}.
 */
export type ChildDocDeclarations = Record<string, ChildDocDeclaration>;

/**
 * The row-typed input form of {@link ChildDocDeclaration}, accepted only by the
 * {@link DeclarableTableDefinition.docs} builder. `touch` is constrained to the
 * row's {@link InstantColumnKey} here, where the row type is still in scope; the
 * stored declaration widens it to `string`. A bare layout still works for bodies
 * that need no policy.
 */
type ChildDocDeclarationInput<TRow extends BaseRow> =
	| ChildDocLayout
	| {
			layout: ChildDocLayout;
			touch?: InstantColumnKey<TRow>;
	  };

/** A map of row-typed child-doc declaration inputs, keyed by field name. */
type ChildDocDeclarationsInput<TRow extends BaseRow> = Record<
	string,
	ChildDocDeclarationInput<TRow>
>;

/** Extract the {@link ChildDocLayout} from either declaration form. */
export type LayoutOf<TDeclaration> = TDeclaration extends ChildDocLayout
	? TDeclaration
	: TDeclaration extends { layout: infer TLayout extends ChildDocLayout }
		? TLayout
		: never;

export type TableDefinition<
	TVersions extends readonly VersionedColumns[] = readonly VersionedColumns[],
	TChildDocs extends ChildDocDeclarations = {},
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
	/**
	 * Child-doc declarations on this table, keyed by field name. `{}` unless
	 * {@link DeclarableTableDefinition.docs} was called. Read by
	 * `defineWorkspace(...).connect(connection)`
	 * to wire one guid-keyed cache per declared body; never carries a connection
	 * itself, since the declaration is isomorphic.
	 */
	docDecls: TChildDocs;
};

/**
 * A fresh {@link TableDefinition} that has not yet declared its child docs and
 * so still carries the one-shot {@link DeclarableTableDefinition.docs}
 * builder. Returned by `defineTable(...)` (and by `.migrate(...)` on a
 * multi-version table).
 *
 * Composed UPWARD from the base: a plain `TableDefinition` (the post-declaration
 * shape every downstream consumer holds) intersected with the `docs`
 * method. `docs` returns the base `TableDefinition`, which has no such
 * method, so a second call is a compile error rather than a silent overwrite.
 * Declaring child docs is therefore call-once by construction; there is no
 * `Omit` stripping the method back off.
 */
export type DeclarableTableDefinition<
	TVersions extends readonly VersionedColumns[] = readonly VersionedColumns[],
> = TableDefinition<TVersions, {}> & {
	/**
	 * Declare collaborative child-doc bodies on this table. Each row owns one
	 * child doc per name (derived-1:1), addressed by a guid derived from the row
	 * id, so nothing is stored in a cell and the body cascades when the row is
	 * deleted (the derived guid simply stops being reachable).
	 *
	 * The runtime surfaces these under a dedicated `.docs` namespace on the table
	 * handle (`workspace.tables.notes.docs.content.open(rowId)`), so field names
	 * live one level below the table's CRUD methods and can never collide with
	 * them. Any field name is safe, including `set` or `open`.
	 *
	 * Call AFTER {@link TableDefinition.migrate} on multi-version tables: the
	 * version tuple is positional, so child docs are a separate builder step, not
	 * another version.
	 *
	 * Declaring is call-once: the result is a plain {@link TableDefinition} with
	 * no `docs` method, so you cannot re-declare and accidentally discard the
	 * original layout or `touch`. Declare every child doc for a table in one
	 * call, co-located with the table definition, and push per-field policy into
	 * that authoritative declaration.
	 *
	 * Pass a bare layout for a body with no per-field policy, or
	 * `{ layout, touch }` to also bump a recency column when the body is edited
	 * locally. `touch` is constrained to the row's `InstantString` columns and is
	 * stamped with `InstantString.now()` on local edits (see
	 * {@link ChildDocDeclaration}):
	 *
	 * ```ts
	 * defineTable({
	 *   id: field.string(),
	 *   title: field.string(),
	 *   updatedAt: field.instant(),
	 * }).docs({
	 *   content: {
	 *     layout: attachRichText,
	 *     touch: 'updatedAt',
	 *   },
	 *   // a bare layout still works for bodies that need no policy:
	 *   // messages: (ydoc) => attachKvStore(ydoc),
	 * });
	 * ```
	 */
	docs<
		TDecls extends ChildDocDeclarationsInput<
			RowOf<LastVersion<TVersions>> & BaseRow
		>,
	>(decls: TDecls): TableDefinition<TVersions, TDecls>;
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
	TableDefinition<any, any>
>;

// ════════════════════════════════════════════════════════════════════════════
// createTableDefinition
// ════════════════════════════════════════════════════════════════════════════

/**
 * Assemble a {@link DeclarableTableDefinition} from resolved versions and a
 * migrate function: the runtime core of {@link defineTable}, kept beside the
 * definition types it builds. `defineTable` (a sibling module) is the only
 * caller, which is the sole reason this is exported rather than module-private.
 *
 * @internal
 */
export function createTableDefinition<
	TVersions extends readonly VersionedColumns[],
>(
	versions: TVersions,
	migrate: (input: unknown) => RowOf<LastVersion<TVersions>>,
): DeclarableTableDefinition<TVersions> {
	const latestColumns = versions[versions.length - 1] as LastVersion<TVersions>;
	const schema = Type.Object(latestColumns);
	const migrateFn = migrate as TableDefinition<TVersions>['migrate'];

	/**
	 * Build the immutable base definition for a given declaration. The base
	 * carries no `docs` method, so `docs(...)` below returns something
	 * that cannot declare again; versions, schema, and migrate are fixed.
	 */
	const buildBase = <TDecls extends ChildDocDeclarations>(
		docDecls: TDecls,
	): TableDefinition<TVersions, TDecls> => ({
		versions,
		schema,
		migrate: migrateFn,
		docDecls,
	});

	// Layer the one-shot builder onto a fresh, undeclared base. `docs`
	// returns a bare base, so a second call is a compile error and is impossible
	// at runtime too (the returned object has no such method).
	return {
		...buildBase({}),
		docs: (decls) => buildBase(decls),
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
	 * one of three buckets, and return them grouped. `scan().rows` is the conforming
	 * payload; the issue buckets ride along so no read silently drops data.
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
	 * entry across all three read states: conforming rows, nonconforming rows
	 * that `scan().rows` excludes, and newer-writer rows. May lag writes made
	 * inside an open transaction. Because it counts all three states, it
	 * reconciles exactly:
	 * `storedCount() === scan.rows.length + scan.nonconforming.length +
	 * scan.newerWriter.length`. For an "N items" badge next to a list, use
	 * `scan().rows.length` instead.
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
	 * stamped by a newer schema version than this binary knows; the stored row
	 * is left untouched because the write would clobber a row this binary cannot
	 * read.
	 */
	set(row: TRow): Result<void, TableWriteError>;
	/**
	 * Chunked whole-row import. Rows whose stored slot this binary cannot read
	 * because of a newer schema version are skipped per chunk at write time and
	 * reported in `refused` as `TableWriteError`; everything else is written.
	 * `onProgress` percent runs over the input length, including refused rows.
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
	 * currently newer schema versions, are skipped and reported in `refused`:
	 * `clear()` is bulk-blind, and a stale binary must not mass-destroy rows it
	 * cannot read. Use `delete(id)` to remove a specific such row.
	 */
	clear(): { refused: TableWriteError[] };
};

/** Map keyed by table name to Table for that table's row type. */
export type Tables<TTableDefinitions extends TableDefinitions> = {
	[K in keyof TTableDefinitions]: Table<InferTableRow<TTableDefinitions[K]>>;
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

/**
 * Whether a stored `_v` is a newer-writer stamp: a row a future binary owns.
 *
 * A legitimate stamp is a whole number; `stamp()` writes `latestVersion` and
 * every schema pins `_v: Literal(N)` with an integer `N`, so no binary, present
 * or future, ever writes a fractional `_v`. A newer writer is therefore an
 * integer strictly above this binary's latest. Everything else (fractional,
 * zero, negative, non-number) is corruption: a repairable nonconforming row,
 * not a "your binary is stale" signal.
 *
 * This is the single owner of the newer-writer rule. The read path
 * ({@link createReadonlyTable}'s `parseRow`) and the write guard
 * (`newerStoredVersion`, feeding `set`/`bulkSet`/`clear`) both route through it,
 * so `scan()` and the write refusals can never disagree about what is repairable
 * versus newer-owned.
 */
function isNewerWriterStamp(
	version: unknown,
	latestVersion: number,
): version is number {
	return (
		typeof version === 'number' &&
		Number.isInteger(version) &&
		version > latestVersion
	);
}

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
	 * Classifies the failure where the version set is in scope: a whole-number
	 * `_v` strictly above the latest known version is a
	 * {@link TableNewerWriterError} (this binary is stale); everything else this
	 * binary should understand but cannot is a {@link TableParseError}.
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
		if (isNewerWriterStamp(version, versions.length)) {
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
			const val = ykv.get(id);
			return val === undefined ? Ok(null) : parseRow(id, val);
		},

		scan(): TableScan<TRow> {
			const rows: TRow[] = [];
			const nonconforming: TableParseError[] = [];
			const newerWriter: TableNewerWriterError[] = [];
			// One pass over the stored entries. Each entry lands in exactly one of
			// the three buckets, so the bucket sum equals storedCount().
			for (const { key, val } of ykv.entries()) {
				const { data, error } = parseRow(key, val);
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
			return { rows, nonconforming, newerWriter };
		},

		findValid(predicate: (row: TRow) => boolean): TRow | undefined {
			for (const { key, val } of ykv.entries()) {
				const { data, error } = parseRow(key, val);
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
			return ykv.observe(handler);
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
	 * without parsing: corrupt values (non-object, missing, or any `_v` that is
	 * not a whole number above the latest, including a fractional stamp) return
	 * undefined so the write proceeds and repairs them. Shares the newer-writer
	 * rule with the read path via {@link isNewerWriterStamp}, so the write guard
	 * and `scan()` agree on what is repairable.
	 *
	 * This is the write guard's single rule, shared by `set()`, `bulkSet()`, and
	 * `clear()`.
	 */
	const newerStoredVersion = (val: unknown): number | undefined => {
		if (typeof val !== 'object' || val === null) return undefined;
		const version = (val as Record<string, unknown>)._v;
		return isNewerWriterStamp(version, latestVersion) ? version : undefined;
	};

	/**
	 * The reason a whole-row write over `id` must be refused, or `undefined`
	 * when the slot is safe to overwrite (absent, conforming, or a repairable
	 * nonconforming row). Refuses a newer-stamped row (`NewerWriterRefusal`).
	 */
	const writeRefusal = (id: string): TableWriteError | undefined => {
		const val = ykv.get(id);
		if (val === undefined) return undefined;
		const storedVersion = newerStoredVersion(val);
		return storedVersion !== undefined
			? TableWriteError.NewerWriterRefusal({
					id,
					storedVersion,
					latestVersion,
				}).error
			: undefined;
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
				// yield below lets a remote sync land a newer-stamped row for a
				// later chunk's id mid-import.
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
			// One pass over every stored entry: newer-stamped rows are refused,
			// everything else is deletable.
			for (const { key, val } of ykv.entries()) {
				const storedVersion = newerStoredVersion(val);
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
			ykv.bulkDelete(toDelete);
			return { refused };
		},
	};
}
