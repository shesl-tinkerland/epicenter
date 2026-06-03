# Wiki: Pages and Tags (an Entity-Component model)

Date: 20260603T180000
Status: Draft. Supersedes the tag/type/trait/collection model in
`20260602T120000-wiki-core-collections-traits-and-curation.md`.

## One sentence

A page is an id, a title, and a body; everything it is, has, or links to is a
tag; a tag may declare typed columns that project to SQLite; markdown and SQLite
are disposable projections of the Yjs truth.

## Decision summary

- **Two things, not one.** `pages` and `tags` stay distinct concepts and distinct
  tables. We REFUSE the Tana/Logseq "a tag is a page" unification (it becomes
  meta fast: can a tag wear tags, does a tag tag itself, where is its schema
  edited). The boundary is principled:
  - `page` = a human-authored knowledge object.
  - `tag` = a reusable annotation / schema facet a page wears.
- **Entity-Component backbone.** A page is an entity; a tag is a component. A page
  composes 0..N tags (composition, not inheritance). A structured tag projects to
  its own SQLite table, so "pages with tag X where field > N" is an indexed JOIN.
  This is the model game engines (Flecs) and Tana/Logseq DB converged on.
- **A plain tag is the empty component.** `{}` = a tag with no columns. Columns
  (from `column.*` helpers) turn it into a structured tag. One primitive, two ends.
- **A tag carries a short `description`, not a page.** The only real need is "what
  is this tag for?", which is one nullable string (tooltip, picker hint). A whole
  page per tag is overkill and quietly reintroduces the tag/page blur we refuse; a
  `[[id]]` inside the description covers the rare "see this page" case, so
  `description` strictly subsumes a `documentationPageId` pointer.
- **References are names, resolved to locators per platform.** Truth stores a
  stable id (page) or an `epicenter://` URN (cross-app). Each platform (web,
  desktop, markdown file) resolves it to a locator at render. The reference never
  carries "how to open."
- **Two id kinds for two id uses** (a consequence of rejecting G3): page ids are
  generated and opaque; tag ids are human slugs. `column.ref()` targets page ids.

## Finalized: capture-cheap and lossless

Three decisions, all chosen to keep capture instant and never lose data:

- **A page wears each tag at most once.** Multiplicity ("two source recordings,
  three citations") lives in a LIST-valued column, not in wearing a tag twice:
  `whispering_recording: { recordings: column.array(column.ref()) }`. The `tags`
  map stays a simple `Record<tagId, values>`; a list-of-refs column expands to
  multiple `edges` rows (still fully queryable). We REFUSE `Record<tagId, values[]>`
  (it would push arrays through every projection, query, and markdown shape).
- **Unknown tags auto-mint a bare definition.** Assigning a tag with no `tags` row
  (typing `#newidea`) upserts a bare definition `{ id, name: id, columns: [], 
  description: null }`. Capture stays instant; promote later by adding columns.
  The assign action and `markdown_push` both mint, so `page_tags` always resolves.
  Typos mint junk tags, same risk as today's free `string[]` tags; acceptable.
- **References may dangle.** A `[[id]]` or `column.ref()` to a not-yet-existing page
  is allowed (wiki red-link behavior). The write never blocks; a dangling ref is
  discoverable as `edges LEFT JOIN pages WHERE pages.id IS NULL`, never an error.

## What a "tag" is

```
ENTITY      page       id + title + body + timestamps
COMPONENT   tag        a named, composable, optionally-typed facet
   plain    {}         membership only           (ECS: a zero-data "tag")
   structured fields   typed columns -> SQLite   (ECS: a "component")
EDGE        ref        a tag/body value that names another page
```

The querying power (the whole point) comes from table-per-structured-tag: each
component is a narrow typed table, and membership is one join away.

## Storage across the three layers

Yjs is the only truth. SQLite and markdown are disposable, always safe to drop
and reproject.

### 1. Yjs truth (`defineTable`)

```ts
// pages: the knowledge objects
export const pagesTable = defineTable({
  id: column.string<PageId>(),          // generated, opaque (page_abc123)
  title: column.string(),
  body: column.string(),                // markdown; promote to Y.Text when concurrent editing is real
  tags: pageTagsCell,                   // Record<TagId, Record<columnId, JsonValue>>; {} = plain tag
  createdAt: column.dateTime(),
  updatedAt: column.dateTime(),
});

// tags: the reusable annotation / schema facets (the registry)
export const tagsTable = defineTable({
  id: column.string<TagId>(),                       // human slug (youtube_video); names a SQL table
  name: column.string(),                            // display, free to rename
  icon: column.nullable(column.string()),
  columns: columnsCell,                             // ColumnSpec[]; [] = plain tag
  description: column.nullable(column.string()),    // what the tag is for; may embed a [[id]]
  createdAt: column.dateTime(),
  updatedAt: column.dateTime(),
});
```

`pageTagsCell` and `columnsCell` use `Type.Unsafe` over a nested record / object
array, exactly as the current branch does for `pages.types` and `types.columns`
(the nested static does not survive the `column.json` gate). `ColumnSpec.schema`
stays the raw `column.*` TSchema, stored verbatim, re-validated with `Value.Check`.

`column.ref()` is a new helper: a string id with a marker (`format: 'epicenter-ref'`)
so the projector can recognize reference columns and build edges. It validates as
a string; its value is a page id or an `epicenter://` URN. `column.array(column.ref())`
is the list form, the standard way to model "many of the same kind" (sources,
citations); each element becomes its own `edges` row.

### 2. SQLite projection (disposable; own database file)

```sql
pages (id PK, title, body, created_at, updated_at) WITHOUT ROWID;

tags (id PK, name, icon, description, created_at, updated_at) WITHOUT ROWID;

tag_columns (                          -- agent-facing schema catalog (no columns_json blob)
  tag_id, column_id, name, schema_json, storage, ordinal,
  PRIMARY KEY (tag_id, column_id)
) WITHOUT ROWID;

page_tags (page_id, tag_id, PRIMARY KEY (page_id, tag_id)) WITHOUT ROWID;  -- THE membership owner

tag_<id> (                             -- ONLY for tags with >= 1 column
  page_id PRIMARY KEY,
  <columnId> <storage>,                -- bare names (duration REAL), not c_duration
  ...
) STRICT, WITHOUT ROWID;

edges (                                -- provenance-aware; derived, never truth
  source_id, rel, target_id,
  source_kind,                         -- 'body_wikilink' | 'structured_field'
  field_id                             -- nullable; the column.ref() column for structured edges
);

projection_issues (                    -- durable values the typed projection refused to place
  page_id, tag_id, column_id,
  kind,                                -- 'invalid' | 'excess'   (never 'missing')
  value_json, message
);
```

Projection rules:
- Plain tags get NO side table; membership lives in `page_tags`.
- Structured tags get `tag_<slug>` with bare, typed columns. `STRICT` asserts the
  affinity the projector already derives (catches projector bugs, no drift).
- `TypeBox is the single validator.` We REFUSE generated `CHECK` constraints: they
  duplicate the schema, can only express a fraction of it, and are redundant
  because the projector validates every cell before insert and routes failures to
  `projection_issues`.
- `edges` is rebuilt from Yjs each projection by scanning body `[[id]]` links
  (source_kind = body_wikilink) and every `column.ref()` value (source_kind =
  structured_field, field_id = the column). A `column.array(column.ref())` emits
  one row per element. Dangling targets are allowed (no FK); find them with a
  LEFT JOIN to `pages`. Never treat `edges` as truth.

### 3. Markdown vault (the browse projection)

```
pages/<id>.md   frontmatter = page core + the tags cell; body = markdown (with [[id]] links)
tags/<id>.md    frontmatter = the tag registry row (columns schema as JSON, description)
```

Example `pages/page_abc.md`:

```yaml
---
id: page_abc
title: Great talk
tags:
  idea: {}
  youtube_video:
    url: https://youtu.be/abc
    duration: 1240
  publishable:
    stage: draft
  whispering_recording:
    recording: epicenter://whispering/recordings/rec_123   # a column.ref() to a cross-app source
createdAt: 2026-06-03T19:00:00.000Z
updatedAt: 2026-06-03T19:00:00.000Z
---
Notes about the talk. See also [[page_def]].
```

References:
- In truth, a reference is a stable NAME: a bare page id in-wiki, an
  `epicenter://app/collection/id` URN cross-app. It never says how to open.
- In markdown it renders as a wikilink `[[id]]` (or `[[id|Title]]` for a readable,
  rename-safe form). On `markdown_push`, `[[id]]` parses back to the reference.
- In the web app it resolves to a path (`/whispering/rec_123`); on desktop to
  in-app navigation. "How to open" is a per-platform resolver, not stored data.

## Asymmetric wins (what we refuse, and why)

- **G3 (a tag is a page).** Refused. A tag's `description` (with an optional
  `[[id]]`) covers the only real need without the recursion. Trigger to revisit:
  tags routinely need their own tags, backlinks, and history as first-class.
- **`source` and `description` as core fields.** Refused.
  - `source` is a typed edge: model it as a tag with a `column.ref()` field
    (`whispering_recording: { recording }`), richer than an opaque `string[]`.
  - `description` decomposes: the preview is derived from `body`; the publish blurb
    is `publishable.excerpt`. Nothing called "description" remains.
- **A separate link-graph subsystem.** Refused. Tags-with-ref-columns already are
  typed edges; `edges` is just their projection.
- **`CHECK` constraints, the `c_` prefix, `wiki_` prefix, empty per-tag tables.**
  Refused (see SQLite rules). Bare names on `WITHOUT ROWID` tables, own database,
  TypeBox as the one validator.

## Normalization rules

```
tag id        ^[a-z][a-z0-9_]*$  (slug; names a SQL table). NO slashes (hierarchy is a
              future `extends`/`parent` field, never encoded in the table name).
              reserved: `columns` (would collide with tag_columns).
tag name      free text; rename is metadata-only (no DDL).
tag id change DESTRUCTIVE: a dedicated rename action that rewrites page.tags keys + reprojects.
column id     ^[a-z][a-z0-9_]*$; reserved: page_id, sqlite_*. Stable, separate from display name.
              rename name = no DDL; add/remove/id-change = DDL.
page id       generated, opaque; STABLE bedrock (edges and refs point at it; never renamed).
```

## Migration from `wiki-page-body-write-actions`

The current branch has `pages.tags: string[]`, `pages.types: Record<typeId, values>`,
and a `types` table. One-way migration (no live dual-reader):

```
tags table   = types table renamed; add documentationPageId (null).
pages.tags{} = { ...fromEntries(oldTags.map(t => [slug(t), {}])), ...oldTypes }
               (typed values win on key collision; old free tags become slugged
                tags whose display name preserves the original string).
markdown     = one-shot vault rewrite: tags: [..] + types: {..} -> tags: {..};
               types/ dir -> tags/.
```

## Build order (what's next)

```
1. Rename types -> tags in schema/index/lens/projection/markdown; pages.types -> pages.tags;
   fold pages.tags string[] into the map as {} entries. (mechanical; see naming table)
   Auto-mint a bare tag definition when an assigned tag has no row.
2. Add column.ref() (string + format marker) and column.array() to the column.* sugar.
3. Projection: page_tags membership + tag_<slug> structured tables + edges (provenance-aware,
   ref[] expands to many rows, dangling allowed) + projection_issues. Own database file;
   bare names; STRICT; WITHOUT ROWID.
4. description on the tags table + markdown round-trip.
5. Tests: plain-tag membership (no side table); structured typed query; rename-no-DDL vs
   add-column-DDL; ref column -> edges row; body [[id]] -> edges row (distinct source_kind).
6. One-way migration script for existing vault data.
```

## Deferred (with triggers)

- **Tag hierarchy / `extends`** (taxonomy): a nullable `parent`/`extends: TagId`.
  Trigger: a real need to inherit columns across tags.
- **`body` as `Y.Text`**: positional-diff collaborative body. Trigger: concurrent
  body editing, or a second body modality (canvas) that makes body-as-tag earn it.
- **Title-as-alias resolution** in `[[Title]]` input: store id, display title,
  support `[[id|Title]]`. Trigger: the wikilink authoring UX is built.
- **Single id namespace / G3 fold**: only if the two-things boundary ever stops
  paying for itself.
