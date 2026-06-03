/**
 * The wiki SQLite projection: the derived, disposable query index.
 *
 * SQLite is never truth. It is re-projected from the CURRENT tag schemas + the
 * pages, so it is always safe to drop and rebuild. It lives in its own database
 * file (no `wiki_` prefix needed, no collision with anything else), and uses
 * bare, typed column names (no `c_` prefix). The shape:
 *
 *   pages (id PK, title, body, created_at, updated_at)            WITHOUT ROWID
 *   tags  (id PK, name, icon, description, created_at, updated_at) WITHOUT ROWID
 *   tag_columns (tag_id, column_id, name, schema_json, storage, ordinal)
 *   page_tags (page_id, tag_id)            -- THE membership owner (every tag)
 *   tag_<slug> (page_id PK, <col> <storage>, ...)  STRICT, WITHOUT ROWID
 *                                          -- ONLY for tags with >= 1 column
 *   edges (source_id, rel, target_id, source_kind, field_id)
 *                                          -- provenance-aware; derived, never truth
 *   projection_issues (page_id, tag_id, column_id, kind, value_json, message)
 *
 * Consequences that fall straight out of this layout:
 *
 *   - A structured tag's physical column is its bare `column_id`, which never
 *     changes on a display rename, so a rename emits NO DDL (`projectWiki`
 *     returns the same `tag_<slug>` DDL string). Adding a column changes the
 *     DDL, so it re-projects.
 *   - Plain tags get NO side table; their membership lives in `page_tags`.
 *   - TypeBox is the single validator: the projector `Value.Check`s every cell
 *     and routes failures to `projection_issues` (kind `invalid`), excess
 *     values (present in data, absent from the current schema) to
 *     `projection_issues` (kind `excess`), and never emits a `CHECK` constraint.
 *   - `edges` is rebuilt every run from body `[[id]]` wikilinks (source_kind
 *     `body_wikilink`) and every `column.ref()` value (source_kind
 *     `structured_field`); a `column.array(column.ref())` emits one row per
 *     element. Dangling targets are allowed (no FK): find them with a LEFT JOIN
 *     to `pages`.
 */

import type { Database } from 'bun:sqlite';
import { deriveStorage, EPICENTER_REF_KEYWORD } from '@epicenter/workspace';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import type { JsonValue } from 'wellcrafted/json';
import {
	COLUMN_ID_PATTERN,
	type Page,
	type WikiTag,
	tagColumns,
	TAG_ID_PATTERN,
} from './schema';

/** Result of one projection run: the DDL emitted per structured-tag side table. */
type ProjectionResult = {
	/** `tagId -> CREATE TABLE` for that structured tag's side table. */
	tagTableDdl: Record<string, string>;
};

/** A reference column's value shape, recognized from its `x-epicenter-ref` keyword. */
type RefKind = 'ref' | 'ref_array';

/**
 * Drop and rebuild the entire derived index from the current registry + pages.
 * Idempotent and disposable: call it again after any schema or data change.
 */
export function projectWiki(
	db: Database,
	{ tags, pages }: { tags: WikiTag[]; pages: Page[] },
): ProjectionResult {
	dropProjectedTables(db);
	createFixedTables(db);

	insertPages(db, pages);
	insertTags(db, tags);
	insertMembership(db, pages);

	const tagTableDdl: Record<string, string> = {};
	for (const tag of tags) {
		if (tagColumns(tag).length === 0) continue; // plain tag: no side table
		tagTableDdl[tag.id] = projectStructuredTag(db, tag, pages);
	}

	insertEdges(db, tags, pages);

	return { tagTableDdl };
}

// ════════════════════════════════════════════════════════════════════════════
// FIXED TABLES
// ════════════════════════════════════════════════════════════════════════════

function createFixedTables(db: Database): void {
	db.run(
		`CREATE TABLE ${q('pages')} (` +
			`${q('id')} TEXT PRIMARY KEY, ${q('title')} TEXT NOT NULL, ` +
			`${q('body')} TEXT NOT NULL, ${q('created_at')} TEXT NOT NULL, ` +
			`${q('updated_at')} TEXT NOT NULL) WITHOUT ROWID`,
	);
	db.run(
		`CREATE TABLE ${q('tags')} (` +
			`${q('id')} TEXT PRIMARY KEY, ${q('name')} TEXT NOT NULL, ` +
			`${q('icon')} TEXT, ${q('description')} TEXT, ` +
			`${q('created_at')} TEXT NOT NULL, ${q('updated_at')} TEXT NOT NULL) WITHOUT ROWID`,
	);
	db.run(
		`CREATE TABLE ${q('tag_columns')} (` +
			`${q('tag_id')} TEXT NOT NULL, ${q('column_id')} TEXT NOT NULL, ` +
			`${q('name')} TEXT NOT NULL, ${q('schema_json')} TEXT NOT NULL, ` +
			`${q('storage')} TEXT NOT NULL, ${q('ordinal')} INTEGER NOT NULL, ` +
			`PRIMARY KEY (${q('tag_id')}, ${q('column_id')})) WITHOUT ROWID`,
	);
	db.run(
		`CREATE TABLE ${q('page_tags')} (` +
			`${q('page_id')} TEXT NOT NULL, ${q('tag_id')} TEXT NOT NULL, ` +
			`PRIMARY KEY (${q('page_id')}, ${q('tag_id')})) WITHOUT ROWID`,
	);
	db.run(
		`CREATE TABLE ${q('edges')} (` +
			`${q('source_id')} TEXT NOT NULL, ${q('rel')} TEXT NOT NULL, ` +
			`${q('target_id')} TEXT NOT NULL, ${q('source_kind')} TEXT NOT NULL, ` +
			`${q('field_id')} TEXT)`,
	);
	db.run(
		`CREATE TABLE ${q('projection_issues')} (` +
			`${q('page_id')} TEXT NOT NULL, ${q('tag_id')} TEXT NOT NULL, ` +
			`${q('column_id')} TEXT NOT NULL, ${q('kind')} TEXT NOT NULL, ` +
			`${q('value_json')} TEXT, ${q('message')} TEXT NOT NULL)`,
	);
}

function insertPages(db: Database, pages: Page[]): void {
	const insert = db.prepare(
		`INSERT INTO ${q('pages')} ` +
			`(${q('id')}, ${q('title')}, ${q('body')}, ${q('created_at')}, ${q('updated_at')}) ` +
			'VALUES (?, ?, ?, ?, ?)',
	);
	for (const page of pages) {
		insert.run(page.id, page.title, page.body, page.createdAt, page.updatedAt);
	}
}

function insertTags(db: Database, tags: WikiTag[]): void {
	const insertTag = db.prepare(
		`INSERT INTO ${q('tags')} ` +
			`(${q('id')}, ${q('name')}, ${q('icon')}, ${q('description')}, ${q('created_at')}, ${q('updated_at')}) ` +
			'VALUES (?, ?, ?, ?, ?, ?)',
	);
	const insertColumn = db.prepare(
		`INSERT INTO ${q('tag_columns')} ` +
			`(${q('tag_id')}, ${q('column_id')}, ${q('name')}, ${q('schema_json')}, ${q('storage')}, ${q('ordinal')}) ` +
			'VALUES (?, ?, ?, ?, ?, ?)',
	);
	for (const tag of tags) {
		insertTag.run(
			tag.id,
			tag.name,
			tag.icon,
			tag.description,
			tag.createdAt,
			tag.updatedAt,
		);
		tagColumns(tag).forEach((spec, ordinal) => {
			insertColumn.run(
				tag.id,
				spec.id,
				spec.name,
				JSON.stringify(spec.schema),
				deriveStorage(spec.schema),
				ordinal,
			);
		});
	}
}

/** Membership owner: one row per (page, tag) for EVERY tag, plain or structured. */
function insertMembership(db: Database, pages: Page[]): void {
	const insert = db.prepare(
		`INSERT INTO ${q('page_tags')} (${q('page_id')}, ${q('tag_id')}) VALUES (?, ?)`,
	);
	for (const page of pages) {
		for (const tagId of Object.keys(page.tags)) insert.run(page.id, tagId);
	}
}

// ════════════════════════════════════════════════════════════════════════════
// STRUCTURED TAG SIDE TABLE
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build and populate one `tag_<slug>` side table from the tag's CURRENT
 * columns. Returns the `CREATE TABLE` statement so callers can prove a rename
 * emits identical DDL while an add does not. Each cell is `Value.Check`ed before
 * insert; failures route to `projection_issues` and store NULL instead.
 */
function projectStructuredTag(
	db: Database,
	tag: WikiTag,
	pages: Page[],
): string {
	const tableName = `tag_${assertTagSlug(tag.id)}`;
	const specs = tagColumns(tag);

	const columnDefs: string[] = [`${q('page_id')} TEXT PRIMARY KEY`];
	for (const spec of specs) {
		columnDefs.push(`${q(assertColumnId(spec.id))} ${deriveStorage(spec.schema)}`);
	}
	const ddl = `CREATE TABLE ${q(tableName)} (${columnDefs.join(', ')}) STRICT, WITHOUT ROWID`;
	db.run(ddl);

	const physicalCols = [q('page_id'), ...specs.map((s) => q(s.id))];
	const insert = db.prepare(
		`INSERT INTO ${q(tableName)} (${physicalCols.join(', ')}) ` +
			`VALUES (${physicalCols.map(() => '?').join(', ')})`,
	);
	const insertIssue = db.prepare(
		`INSERT INTO ${q('projection_issues')} ` +
			`(${q('page_id')}, ${q('tag_id')}, ${q('column_id')}, ${q('kind')}, ${q('value_json')}, ${q('message')}) ` +
			'VALUES (?, ?, ?, ?, ?, ?)',
	);

	const schemaIds = new Set(specs.map((s) => s.id));
	for (const page of pages) {
		const data = page.tags[tag.id];
		if (data === undefined) continue; // page does not wear this tag

		const cells = specs.map((spec) => {
			if (!Object.hasOwn(data, spec.id)) return null; // missing is not an issue
			const value = data[spec.id]!;
			if (Value.Check(spec.schema, value)) return serializeValue(value);
			insertIssue.run(
				page.id,
				tag.id,
				spec.id,
				'invalid',
				JSON.stringify(value),
				`value does not satisfy column "${spec.id}" schema`,
			);
			return null;
		});
		insert.run(page.id, ...cells);

		for (const [columnId, value] of Object.entries(data)) {
			if (schemaIds.has(columnId)) continue;
			insertIssue.run(
				page.id,
				tag.id,
				columnId,
				'excess',
				JSON.stringify(value),
				`no column "${columnId}" in the current schema of tag "${tag.id}"`,
			);
		}
	}

	return ddl;
}

// ════════════════════════════════════════════════════════════════════════════
// EDGES (provenance-aware; rebuilt every run, dangling targets allowed)
// ════════════════════════════════════════════════════════════════════════════

function insertEdges(db: Database, tags: WikiTag[], pages: Page[]): void {
	const insert = db.prepare(
		`INSERT INTO ${q('edges')} ` +
			`(${q('source_id')}, ${q('rel')}, ${q('target_id')}, ${q('source_kind')}, ${q('field_id')}) ` +
			'VALUES (?, ?, ?, ?, ?)',
	);
	const byId = new Map<string, WikiTag>(tags.map((tag) => [tag.id, tag]));

	for (const page of pages) {
		// Body wikilinks: [[id]] (or [[id|Title]]) become a body_wikilink edge.
		for (const targetId of parseWikilinks(page.body)) {
			insert.run(page.id, 'links_to', targetId, 'body_wikilink', null);
		}

		// Structured-field references: each column.ref() / column.array(column.ref())
		// value names a target. The relationship is the tag id; the field is the
		// column. An array expands to one row per element.
		for (const [tagId, data] of Object.entries(page.tags)) {
			const tag = byId.get(tagId);
			if (tag === undefined) continue;
			for (const spec of tagColumns(tag)) {
				if (!Object.hasOwn(data, spec.id)) continue;
				const kind = refKind(spec.schema);
				if (kind === null) continue;
				for (const targetId of refTargets(kind, data[spec.id])) {
					insert.run(page.id, tagId, targetId, 'structured_field', spec.id);
				}
			}
		}
	}
}

/** Collect `[[id]]` / `[[id|Title]]` targets from a markdown body, in order. */
function parseWikilinks(body: string): string[] {
	const targets: string[] = [];
	const pattern = /\[\[([^[\]|]+?)(?:\|[^[\]]*)?\]\]/g;
	for (const match of body.matchAll(pattern)) {
		const id = match[1]?.trim();
		if (id) targets.push(id);
	}
	return targets;
}

type SchemaShape = {
	type?: string;
	[EPICENTER_REF_KEYWORD]?: unknown;
	items?: TSchema & SchemaShape;
};

const isRefString = (s: SchemaShape): boolean =>
	s.type === 'string' && s[EPICENTER_REF_KEYWORD] === true;

/** Whether a column schema is a reference (`column.ref`) or a list of references. */
function refKind(schema: TSchema): RefKind | null {
	const s = schema as SchemaShape;
	if (isRefString(s)) return 'ref';
	if (s.type === 'array' && s.items && isRefString(s.items)) return 'ref_array';
	return null;
}

/** Extract the target id(s) of a stored reference value (one for `ref`, N for `ref_array`). */
function refTargets(kind: RefKind, value: JsonValue | undefined): string[] {
	if (kind === 'ref') return typeof value === 'string' ? [value] : [];
	if (!Array.isArray(value)) return [];
	return value.filter((element): element is string => typeof element === 'string');
}

// ════════════════════════════════════════════════════════════════════════════
// SQLITE HELPERS (self-contained; the workspace internals are not public)
// ════════════════════════════════════════════════════════════════════════════

/** The fixed (non-`tag_<slug>`) tables this projection owns. */
const FIXED_TABLES = new Set([
	'pages',
	'tags',
	'tag_columns',
	'page_tags',
	'edges',
	'projection_issues',
]);

/**
 * Drop every projected table so the next projection is a clean rebuild: the
 * fixed set plus every `tag_<slug>` side table (any `tag_*` name, which also
 * sweeps `tag_columns`, already in the fixed set).
 */
function dropProjectedTables(db: Database): void {
	const rows = db
		.query<{ name: string }, []>(
			"SELECT name FROM sqlite_master WHERE type = 'table'",
		)
		.all();
	for (const { name } of rows) {
		if (FIXED_TABLES.has(name) || name.startsWith('tag_')) {
			db.run(`DROP TABLE IF EXISTS ${q(name)}`);
		}
	}
}

/** Double-quote a SQL identifier, escaping embedded quotes. */
function q(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

/** A tag id becomes a physical table-name segment, so keep it slug-shaped. */
function assertTagSlug(value: string): string {
	if (!TAG_ID_PATTERN.test(value)) {
		throw new Error(
			`tag id "${value}" is not a safe table-name segment (expected ${TAG_ID_PATTERN})`,
		);
	}
	return value;
}

/** A column id becomes a bare physical column name; keep it slug-shaped, never the PK. */
function assertColumnId(value: string): string {
	if (!COLUMN_ID_PATTERN.test(value) || value === 'page_id') {
		throw new Error(
			`column id "${value}" is not a safe column name (expected ${COLUMN_ID_PATTERN}, not "page_id")`,
		);
	}
	return value;
}

/** Convert a stored JSON value into a SQLite binding. */
function serializeValue(value: JsonValue | undefined): string | number | null {
	if (value === null || value === undefined) return null;
	if (typeof value === 'boolean') return value ? 1 : 0;
	if (typeof value === 'object') return JSON.stringify(value);
	return value;
}
