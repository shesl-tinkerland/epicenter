/**
 * Wiki schema: the two first-party tables and the shared types.
 *
 * The whole model is two ordinary `defineTable` schemas (an Entity-Component
 * backbone):
 *
 *   tags    the registry of reusable annotation / schema facets. Each row IS a
 *           tag: a stable human slug id, a display name, an optional icon, a
 *           short `description` (what the tag is for; may embed a `[[id]]`), and
 *           `columns` (the user's schema, stored as ColumnSpec[]). A tag with
 *           `columns: []` is a PLAIN tag (membership only); a tag with columns is
 *           a STRUCTURED tag (a typed component) that projects to its own SQLite
 *           table. Materialized to `tags/<id>.md`.
 *
 *   pages   the knowledge objects. A minimal core (id, title, body, timestamps)
 *           plus ONE nested json cell `tags` holding membership + values, keyed
 *           by tag id. A page is a `youtube_video` iff its `tags` cell has that
 *           key; a plain tag is the empty object `{}`. A page wears each tag at
 *           most once (multiplicity lives in a `column.array(column.ref())`
 *           column, never in wearing a tag twice).
 *
 * `body` is a plain string column on the row for this slice (routed to the
 * markdown file's body section by `./markdown.ts`, never into frontmatter). It
 * shares the row's whole-row LWW, the same trade every page already accepts.
 * Promote it to a per-row content `Y.Doc` (fuji's entry-body pattern) when
 * collaborative or independently-syncing body editing is real.
 */

import { column, defineTable, type InferTableRow } from '@epicenter/workspace';
import { type TSchema, Type } from 'typebox';
import type { Brand } from 'wellcrafted/brand';
import type { JsonObject, JsonValue } from 'wellcrafted/json';

/** Stable id of a wiki page (the markdown file stem, the row key). Generated, opaque. */
export type PageId = string & Brand<'PageId'>;
/** Stable id of a tag (a human slug like `youtube_video`); also names a SQL table. */
export type TagId = string & Brand<'TagId'>;

export const asPageId = (value: string): PageId => value as PageId;
export const asTagId = (value: string): TagId => value as TagId;

/**
 * A tag id is a stable slug (must start with a letter); it also becomes a SQL
 * table-name segment. No slashes: hierarchy is a future `parent` field, never
 * encoded in the table name.
 */
export const TAG_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * `columns` is reserved as a tag id: it would collide with the `tag_columns`
 * projection table.
 */
export const RESERVED_TAG_ID = 'columns';

/** A column id is a stable slug, separate from its display name. */
export const COLUMN_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

/** A column.* result is a non-null JSON object; a string/array/primitive is not. */
export function isTSchemaObject(value: unknown): boolean {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One column of a structured tag.
 *
 * - `id` is the stable physical id. A rename never touches it, which is what
 *   makes a display rename metadata-only (no SQL DDL).
 * - `name` is the display name; free to change.
 * - `schema` is the column's TypeBox schema, authored with the real `column.*`
 *   builders (`column.url()`, `column.ref()`, `column.array(column.ref())`) so
 *   call sites get autocomplete and type-checking. A `TSchema` IS JSON Schema,
 *   so it is stored verbatim and re-validated with `Value.Check` after the
 *   Yjs/JSON round-trip (this TypeBox validates on plain JSON Schema, no
 *   `[Kind]` symbols, so a round-tripped schema validates identically). NO
 *   eval, NO codegen, NO interpreter.
 */
export type ColumnSpec = {
	id: string;
	name: string;
	schema: TSchema;
};

/**
 * The `tags.columns` cell.
 *
 * A `TSchema` IS a JSON object at runtime, but TypeBox's `TSchema` static type
 * is not seen as `JsonValue`, so `defineTable`'s SQLite-safe gate would reject a
 * `schema: TSchema` field. The cell therefore stores `schema` as a JSON object
 * and `tagColumns()` reads it back as a `ColumnSpec` (schema as `TSchema`).
 * The runtime value is the same object either way.
 */
type StoredColumnSpec = { id: string; name: string; schema: JsonObject };

const columnsCell = Type.Unsafe<StoredColumnSpec[]>(
	Type.Array(
		Type.Object({
			id: Type.String(),
			name: Type.String(),
			schema: Type.Unknown(),
		}),
	),
);

/**
 * The `pages.tags` cell: membership + values, keyed by tag id then column id.
 *
 *   { idea: {}, youtube_video: { url: "https://...", duration: 1240 } }
 *
 * `{}` is a plain tag (membership only). Like `columnsCell`, this uses
 * `Type.Unsafe` rather than `column.json`: the exact
 * `Record<string, Record<string, JsonValue>>` static carries through while the
 * runtime schema stays an `object` the SQLite layer maps to a TEXT cell. Do not
 * "simplify" it back to `column.json`; the nested-record static does not
 * survive that gate.
 */
export type PageTagValues = Record<string, Record<string, JsonValue>>;

const pageTagsCell = Type.Unsafe<PageTagValues>(
	Type.Record(Type.String(), Type.Record(Type.String(), Type.Unknown())),
);

/** The tags registry: one row per reusable annotation / schema facet. */
export const tagsTable = defineTable({
	id: column.string<TagId>(),
	name: column.string(),
	icon: column.nullable(column.string()),
	columns: columnsCell,
	description: column.nullable(column.string()),
	createdAt: column.dateTime(),
	updatedAt: column.dateTime(),
});

/** The pages table: minimal core + the nested `tags` cell + body. */
export const pagesTable = defineTable({
	id: column.string<PageId>(),
	title: column.string(),
	body: column.string(),
	tags: pageTagsCell,
	createdAt: column.dateTime(),
	updatedAt: column.dateTime(),
});

export type WikiTag = InferTableRow<typeof tagsTable>;
export type Page = InferTableRow<typeof pagesTable>;

/**
 * Read a registry row's columns as authoring `ColumnSpec[]` (each `schema` a
 * `TSchema`). The single boundary where the stored JSON-object schema is read
 * back as a TypeBox schema; the runtime value is unchanged.
 */
export function tagColumns(tag: WikiTag): ColumnSpec[] {
	return tag.columns as unknown as ColumnSpec[];
}

export const wikiTableDefinitions = {
	tags: tagsTable,
	pages: pagesTable,
};
