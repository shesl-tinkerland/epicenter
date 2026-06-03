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
 *   page_tags (page_id, tag_id)            -- THE membership owner (every tag)
 *   tag_<slug> (page_id PK, <col> <storage>, ...)  STRICT, WITHOUT ROWID
 *                                          -- ONLY for tags with >= 1 column
 *   edges (source_id, rel, target_id, source_kind, field_id)
 *                                          -- provenance-aware; derived, never truth
 *
 * Consequences that fall straight out of this layout:
 *
 *   - A structured tag's physical column is its bare `column_id`, which never
 *     changes on a display rename, so a rename emits NO DDL (`projectWiki`
 *     returns the same `tag_<slug>` DDL string). Adding a column changes the
 *     DDL, so it re-projects.
 *   - Plain tags get NO side table; their membership lives in `page_tags`.
 *   - TypeBox is the single validator: the projector `Value.Check`s every cell
 *     before insert and stores NULL on a miss, never a generated `CHECK`
 *     constraint. The durable value survives in Yjs; the on-read lens
 *     (`./lens.ts`) is what surfaces invalid / excess values for a page.
 *   - `edges` is rebuilt every run from body `[[id]]` wikilinks (source_kind
 *     `body_wikilink`) and every cell value that is an `epicenter://` URN
 *     (source_kind `structured_field`); a list of URNs emits one row per
 *     element. References are recognized from the VALUE (the URN scheme), never
 *     a schema marker, exactly like `[[id]]` is recognized in body prose.
 *     Dangling targets are allowed (no FK): find them with a LEFT JOIN to
 *     `pages`.
 */

import type { Database } from 'bun:sqlite';
import { deriveStorage } from '@epicenter/workspace';
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

	insertEdges(db, pages);

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
	for (const tag of tags) {
		insertTag.run(
			tag.id,
			tag.name,
			tag.icon,
			tag.description,
			tag.createdAt,
			tag.updatedAt,
		);
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
 * insert; a value that fails its column schema (or is absent) stores NULL. The
 * durable value survives in Yjs, and the on-read lens (`./lens.ts`) is what
 * surfaces the mismatch; excess values (no current column) simply do not
 * project.
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

	for (const page of pages) {
		const data = page.tags[tag.id];
		if (data === undefined) continue; // page does not wear this tag

		const cells = specs.map((spec) => {
			if (!Object.hasOwn(data, spec.id)) return null;
			const value = data[spec.id]!;
			return Value.Check(spec.schema, value) ? serializeValue(value) : null;
		});
		insert.run(page.id, ...cells);
	}

	return ddl;
}

// ════════════════════════════════════════════════════════════════════════════
// EDGES (provenance-aware; rebuilt every run, dangling targets allowed)
// ════════════════════════════════════════════════════════════════════════════

function insertEdges(db: Database, pages: Page[]): void {
	const insert = db.prepare(
		`INSERT INTO ${q('edges')} ` +
			`(${q('source_id')}, ${q('rel')}, ${q('target_id')}, ${q('source_kind')}, ${q('field_id')}) ` +
			'VALUES (?, ?, ?, ?, ?)',
	);

	for (const page of pages) {
		// Body wikilinks: [[id]] (or [[id|Title]]) become a body_wikilink edge.
		for (const targetId of parseWikilinks(page.body)) {
			insert.run(page.id, 'links_to', targetId, 'body_wikilink', null);
		}

		// Structured-field references: any cell value that is an `epicenter://`
		// URN (or a list of them) names a target. References are recognized from
		// the VALUE, never a schema marker, exactly like `[[id]]` in the body: the
		// URN scheme is self-describing. The relationship is the tag id; the field
		// is the column. A list expands to one row per URN element.
		for (const [tagId, data] of Object.entries(page.tags)) {
			for (const [fieldId, value] of Object.entries(data)) {
				for (const targetId of refUrns(value)) {
					insert.run(page.id, tagId, targetId, 'structured_field', fieldId);
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

/** The `epicenter://` URN scheme that self-identifies a value as a cross-entity reference. */
const REF_URN_PREFIX = 'epicenter://';

const isRefUrn = (value: JsonValue): value is string =>
	typeof value === 'string' && value.startsWith(REF_URN_PREFIX);

/** Reference targets in a stored cell value: the value itself if a URN, or every URN element of a list. */
function refUrns(value: JsonValue | undefined): string[] {
	if (value === undefined) return [];
	if (isRefUrn(value)) return [value];
	if (Array.isArray(value)) return value.filter(isRefUrn);
	return [];
}

// ════════════════════════════════════════════════════════════════════════════
// SQLITE HELPERS (self-contained; the workspace internals are not public)
// ════════════════════════════════════════════════════════════════════════════

/** The fixed (non-`tag_<slug>`) tables this projection owns. */
const FIXED_TABLES = new Set(['pages', 'tags', 'page_tags', 'edges']);

/**
 * Drop every projected table so the next projection is a clean rebuild: the
 * fixed set plus every `tag_<slug>` side table (any `tag_*` name).
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
