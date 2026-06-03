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
 *           most once (multiplicity lives in a `column.array(column.string())`
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

/**
 * A tag id is a stable slug (must start with a letter); it also becomes a SQL
 * table-name segment. No slashes: hierarchy is a future `parent` field, never
 * encoded in the table name.
 */
export const TAG_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * `columns` is reserved as a tag id by the wiki normalization rules, keeping the
 * tag-id namespace clear of an internal-sounding name.
 */
export const RESERVED_TAG_ID = 'columns';

/** A column id is a stable slug, separate from its display name. */
export const COLUMN_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * One column of a structured tag, AS STORED.
 *
 * - `id` is the stable physical id. A rename never touches it, which is what
 *   makes a display rename metadata-only (no SQL DDL).
 * - `name` is the display name; free to change.
 * - `schema` is the column's TypeBox schema. It is never hand-authored: an agent
 *   passes a `ColumnInput` descriptor and `buildColumnSchema` compiles it. The
 *   resulting `TSchema` IS JSON Schema, so it is stored verbatim and re-validated
 *   with `Value.Check` after the Yjs/JSON round-trip (TypeBox validates on plain
 *   JSON Schema, no `[Kind]` symbols, so a round-tripped schema validates
 *   identically). NO eval, NO codegen, NO interpreter.
 */
export type ColumnSpec = {
	id: string;
	name: string;
	schema: TSchema;
};

/**
 * The closed set of column kinds an agent can author. Each maps to a `column.*`
 * builder; the projector derives SQLite storage from the built schema. A
 * reference is NOT a kind: it is a `string` (or an `array` of strings) whose
 * value is an `epicenter://` URN, recognized by value, never by the schema.
 */
export type ColumnKind =
	| 'string'
	| 'number'
	| 'integer'
	| 'boolean'
	| 'datetime'
	| 'url'
	| 'enum';

/**
 * The authoring descriptor for one column: a closed `kind` plus modifiers, never
 * a hand-written JSON Schema. `buildColumnSchema` compiles it to the stored
 * `TSchema`. This is the ONLY vocabulary the actions accept, so a stored schema
 * is always a real `column.*` result (the input layer rejects unknown kinds, so
 * no junk can land).
 */
export type ColumnInput = {
	id: string;
	name: string;
	kind: ColumnKind;
	/** Wrap the value as `value | null`. */
	nullable?: boolean;
	/** A list of the kind ("many of a kind"); each `epicenter://` element is its own edge. */
	array?: boolean;
	/** Required when `kind` is `enum`: the allowed literal values. */
	enumValues?: string[];
};

/**
 * Compile an authoring descriptor to the stored `TSchema`, via the `column.*`
 * builders (no eval, no parser, just a switch). Modifiers compose on the base:
 * `nullable` wraps the value, `array` wraps a list. Throws on an `enum` with no
 * values (the action validates that first and returns a clean error).
 */
export function buildColumnSchema(input: ColumnInput): TSchema {
	let schema: TSchema = baseColumnSchema(input);
	if (input.nullable) schema = column.nullable(schema);
	if (input.array) schema = column.array(schema);
	return schema;
}

function baseColumnSchema(input: ColumnInput): TSchema {
	switch (input.kind) {
		case 'string':
			return column.string();
		case 'number':
			return column.number();
		case 'integer':
			return column.integer();
		case 'boolean':
			return column.boolean();
		case 'datetime':
			return column.dateTime();
		case 'url':
			return column.url();
		case 'enum':
			return column.enum(input.enumValues ?? []);
		default: {
			const unreachable: never = input.kind;
			throw new Error(`unknown column kind: ${String(unreachable)}`);
		}
	}
}

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
 * `{}` is a plain tag (membership only). This schema is a live validator, not a
 * typing trick: `getAllValid` runs `Value.Check` on it when materializing a
 * page, so a `tags` cell that is not a map-of-maps is rejected before it can
 * reach SQLite or any reader. Writes only ever arrive through validated actions
 * (`pages_create`, `pages_assign_tag`) or a statically-typed `.set`, so that read
 * gate is defense in depth. The `Unknown` leaf is deliberate: leaf values are
 * already JSON (every ingress is a JSON round-trip), so re-policing them on every
 * read would be wasted work.
 *
 * It uses raw `Type.Unsafe` rather than `column.json` because `column.json`
 * derives its static from the schema and gates on `Static<S> extends JsonValue`;
 * the `Unknown` leaf infers `unknown`, which is not `JsonValue`, so the naive
 * `column.json(Type.Record(..., Type.Unknown()))` is a compile error.
 * `Type.Unsafe` pins the precise `PageTagValues` static while the same `object`
 * runtime schema maps to a TEXT cell. Do not "simplify" it back to `column.json`.
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
