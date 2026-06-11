# Schema-Declared Body Docs (derive the doc set from the schema)

**Date**: 2026-05-30
**Status**: Superseded by
`specs/20260530T230000-bodies-as-generic-doc-opener.md` and PR #1868. Do not
implement `column.body`, schema-declared body docs, `attachBodyCache`, or a generic
schema-enumerating daemon from this spec. Its Yjs grounding remains useful history:
rich collaborative content cannot live inside encrypted row values, and Fuji still
uses deterministic per-entry body doc guids.
**Owner**: Workspace platform

## Relationship to prior specs

```txt
SUPERSEDES (mechanism only)  20260530T160000-uniform-per-doc-providers.md
                             its workspace.docs registry + attachWorkspaceProviders.
                             That design (and a later "inject a decorator into the iso
                             factory" alternative) are recorded here as refusals.

REFRAMES                     20260530T120000-daemon-manifest-and-mount-materializers.md
                             the "daemon must persist child docs generically" dependency.
                             This spec changes HOW (derive the doc set from the schema),
                             not the manifest/read-surface conclusions, which still hold.

BUILDS ON                    the deterministic docGuid scheme that already exists and is
                             identical across all three body-doc apps (verified below).
```

## One Sentence

Superseded model: Fuji entry bodies are app-owned Y.Docs, not schema-declared
columns; `createFuji()` owns the root entries table and actions, browser runtime
code owns the `entryBodies` cache, and the daemon opens one body doc at a time only
to derive markdown.

Historical rejected model:

A body field is declared in the schema as a child Y.Doc whose content codec rides the
column by value (rich text, timeline, or any handle exposing `read(): string`), so a
workspace's full set of docs becomes a pure function of the root data that every runtime
derives the same way: this deletes the per-app, per-runtime doc-wiring machinery (caches,
registries, provider threading) and turns the daemon into a generic body-observing
replicator instead of an app instance.

---

## Why we got here (the short story)

We started trying to let the daemon persist + sync child body docs. Every path led to
machinery: a `workspace.docs` registry, then an injected `attachChildDoc` decorator,
each threaded through every app's child-doc cache. It kept feeling heavy. Stepping all
the way out surfaced the real cause.

```txt
Local symptom:
  The daemon can't attach storage+sync to child body docs without per-app wiring.

One level up:
  Why does the daemon have to OPEN child docs through the app's lazy cache at all?
  The cache is a BROWSER concern (open one entry, edit, close: lazy + refcount + gc).
  The daemon is a BATCH SWEEP (read every row, project every body). It never
  navigates. We were forcing UI machinery onto a non-UI runtime.

Root cause (the missing owner):
  "Which rows have a body doc, and at what guid" is a deterministic pure function that
  already exists and is IDENTICAL across all three apps, but it is INVISIBLE to the
  schema. Nothing can enumerate a workspace's doc set generically. So every runtime
  re-derives the relationship by hand. All the threading is compensation for a fact
  the schema does not own.
```

## Grounded facts (verified against the code, not assumed)

```txt
1. Child guid is a pure deterministic function, identical across all three apps:
     docGuid({workspaceId, collection, rowId, field}) = `${id}.${collection}.${rowId}.${field}`
       packages/workspace/src/document/doc-guid.ts:27
     fuji        entryContentDocGuid(id)  -> docGuid(FUJI_ID, 'entries', id, 'content')
       apps/fuji/src/lib/workspace/index.ts:414
     honeycrisp  noteBodyDocGuid(id)      -> docGuid(HONEYCRISP_ID, 'notes', id, 'body')
       apps/honeycrisp/honeycrisp.ts:217
     opensidian  fileContentDocGuid(...)  -> docGuid(workspaceId, 'files', id, 'content')
       packages/filesystem/src/file-content-docs.ts:4

2. The schema knows NOTHING about body docs. The entries table (defineTable) is plain
   metadata columns; the body relationship is hand-wired OUTSIDE it via a separate
   createDisposableCache + the guid function.
     apps/fuji/src/lib/workspace/index.ts:64 (table)  and :137 (the separate cache)

3. The daemon already builds the full app iso factory (createFuji), carrying its child
   cache, but NEVER calls .open() on it: it only wires the root workspace.ydoc + the
   materializers. The child cache sits inert on the daemon today.
     apps/fuji/src/lib/workspace/project.ts (open(ctx): createFuji + attachProjectSync(workspace.ydoc, ...))

4. There is NO enumeration of "all rooms for a workspace/owner" anywhere: not in the
   cloud, not in sync. Rooms are name-on-demand by guid. The only way to know the child
   set is to apply the guid function to the rows.
     packages/sync/src/room-route.ts:14  (route by (ownerId, roomId), no list)

5. Reading a body for materialization is: open the child Y.Doc, xmlFragmentToPlaintext
   (block-aware) the rich-text fragment. No app object model is required: a bare
   Y.Doc + attachRichText().read() is enough, so the daemon can read any body
   generically.
     packages/workspace/src/document/attach-rich-text.ts:30,78

6. Encryption has TWO independent boundaries, and bodies sit in a blind spot of one
   of them (verified, corrects the earlier loose "transparent at the Y.Doc layer"):
     a. Per-VALUE (row payloads): the encrypted YKV wraps each row value with
        JSON.stringify + XChaCha20-Poly1305 BEFORE it enters the Y.Array. The relay's
        in-memory Y.Doc therefore holds ciphertext as the ContentAny value; the relay
        sees structure (which keys exist, LWW ts, counts) but not row content.
          packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts:201
     b. Per-DOCUMENT-UPDATE-BYTES (at rest, browser only): attachLocalStorage ->
        attachEncryptedIndexedDb encrypts the whole Yjs updateV2 binary with a key
        derived from ydoc.guid, before IndexedDB. This covers ANY shared type,
        including a bare Y.XmlFragment.
          packages/workspace/src/document/attach-encrypted-indexed-db.ts:92,134,238
   A rich-text BODY (a bare Y.XmlFragment, no YKV value layer) is covered by (b) at
   rest in the browser, but NOT by (a). On the wire and on the daemon it is plaintext:
     - cloud sync sends raw updateV2 bytes, no encryption
         packages/workspace/src/document/internal/sync-supervisor.ts:233 (encodeSyncUpdate)
     - the daemon yjs-log writes raw updateV2 bytes, no encryption
         packages/workspace/src/document/attach-yjs-log.ts
   Consequence: the relay and the daemon's local log can read body rich text in the
   clear TODAY (this is already true for fuji's entry content docs). Body content is
   NOT confidential from the relay. Inline-vs-child does not change this: both store
   rich text as live CRDT structure outside the value-encryption layer.

7. Nothing in the repo uses Yjs subdocuments. Every collaborating document is a
   separate top-level Y.Doc addressed by guid: roomWsUrl(guid), yjsPath(guid), the
   encrypted-IDB key (deriveWorkspaceKeyring(keyring, guid)). The body-doc design must
   stay inside this guid-addressed model.
```

The important consequence of fact 1 + fact 4: the child doc set is **already** fully
derivable from the root data. We just never told the schema, so nothing derives it.

## Yjs grounding (verified against yjs/yjs via DeepWiki)

These four answers are load bearing for the decisions below. They are not assumptions.

```txt
Q1. Can a Y.Text / Y.XmlFragment live as a value inside a Y.Array/Y.Map-backed KV row?
    NO. A shared type is collaborative only when integrated directly (ymap.set(k, new
    Y.Text()) -> ContentType) or nested as a child of another shared type. A shared
    type placed as a FIELD of a plain object value is stored as ContentAny: Yjs treats
    the whole object as an opaque primitive and the shared type loses all CRDT
    behavior. Epicenter rows are exactly this case: the YKV value is a plain object
    that is JSON.stringify'd (and encrypted) on write, so a nested shared type cannot
    survive. Bodies must be attached BY NAME on a Y.Doc (getXmlFragment(name)), never
    embedded in a row value.

Q2. What if a shared type is serialized into a row value and rewritten through the KV?
    It is dead data. JSON.stringify produces toJSON() (a static snapshot). The LWW KV
    then treats it as an opaque value and every write re-stamps a timestamp and
    REPLACES the whole value, so two concurrent body edits clobber wholesale by
    timestamp instead of merging character by character. The encrypted variant also
    encrypts the snapshot. You get neither CRDT merge nor live editing. This kills
    "serialized Yjs blob in a row value" outright.

Q3. Many top-level named Y.XmlFragments in ONE root doc vs many child docs?
    One root doc with N fragments = one StructStore, one update stream, all-or-nothing
    load. Every device that opens the workspace loads every body; every keystroke in
    every body rides the root update stream; GC is shared. Many child docs = isolated
    StructStore / update stream / load / GC per body, lazy by design. Epicenter already
    uses child docs. Inline (root fragments) is acceptable only for a bounded app.

Q4. Yjs subdocuments, or separate top-level docs with deterministic guids?
    Stay with separate top-level docs + deterministic guids. Subdocuments also give
    independent load/sync, but they require the PARENT doc to carry a ContentDoc item
    per body: a second source of truth for "which bodies exist" that must be kept
    consistent with the rows. That is precisely the redundancy this spec deletes: the
    deterministic guid already makes the doc set a pure function of the rows, with no
    parent-embedded references. Subdocs would also force the relay, room router, IDB
    persistence, and yjs-log (all guid-addressed today, fact 7) to learn parent/child
    relationships for zero benefit over the guid scheme.
```

---

## The asymmetric win

Declare the body relationship in the schema. Derive everything else.

```ts
const entriesTable = defineTable({
  id:      column.string<EntryId>(),
  title:   column.string(),
  content: column.body(richText()),  // a child Y.Doc at docGuid(workspaceId,'entries',id,'content');
                                      // the codec (richText() / timeline()) rides the column by value
  // ...
});
```

With one declaration, the doc set is a pure function of the root, and every consumer
derives it the same way:

```txt
                  TODAY (hand-wired per app)              AFTER (derived from schema)
entry->body link  implicit in code, 3 places             explicit, declared once, all derive
browser cache     3x createDisposableCache + guid fn      1 generic attachBodyCache keyed off body guid
daemon sync       cannot enumerate children at all        bodyDocGuids(rows) -> sync + observe each
daemon materialize opens app cache, needs threading       iterate body columns x rows -> codec.read() each
provider wiring   registry / decorator / whenLoaded       two openers (root + body) sharing per-doc attach
```

### The limiting case: inline bodies delete child docs entirely

`column.body()` has a sibling that, for bounded-size apps, removes the whole child-doc
machine:

```ts
content: column.text(),     // EXPLORATORY: inline rich-text IN the root doc.
                            // No child doc, no room, no cache, no derivation. One doc.
```

For an app whose bodies are small and bounded (a journal, a light notes app), inline
bodies mean one doc, one provider pair, zero child machinery. The schema knob lets each
app choose per field. Opensidian (a file vault, large + many bodies) stays
`column.body()`; Fuji / Honeycrisp are the candidates to evaluate. This is the
"refuse 10-20% to delete 80%" lever: simple apps give up per-body lazy load + per-body
sync granularity and in exchange the entire child-doc apparatus vanishes for them.

> CORRECTION (see decision B): this "limiting case" framing is REFUSED for now. Inline
> rich text cannot live in a row value (Yjs Q1/Q2); the only coherent form is a separate
> top-level root-doc Y.XmlFragment per row, which is a PARALLEL body machine (its own
> derivation, its own row-delete orphan cleanup, all-or-nothing root load), not a
> deletion of the child machine. column.text() is deferred until a concrete bounded app
> earns it. Keep this subsection only as the original motivation; decision B governs.

---

## What is a daemon, then? (the reframe)

Today the daemon instantiates the full app object model (its iso factory + browser-style
cache) and tries to reuse UI machinery. The reframe:

> A daemon is a **generic workspace replicator + materializer**. Given a schema (with
> body declarations) + the app's actions + materializers + a keyring, it reads the root,
> derives the doc set, syncs each doc, and projects via the materializers. It does not
> instantiate the browser's lazy cache, and it needs zero app-specific doc-wiring code.

```txt
daemon, generic across ALL mounts:
  1. build root from the schema (+ actions); pin clientID
  2. derive child room set:  for each table, each body column, each row -> docGuid(...)
  3. sync every room (root + children): bare Y.Doc + yjs-log + openCollaboration, by guid
  4. materialize: for each body, read rich-text -> markdown/sqlite (materializer owns the serializer)
  5. observe the root table: new/deleted rows -> add/remove rooms
```

No `attachChildDoc`, no `createDocCache`, no registry, no per-app daemon mount code.

---

## The new API (composition surface)

> This section REPLACES the earlier "ideal call sites" sketches (which used a
> `role: 'root' | 'body'` provider factory and an `openWorkspace(schema, { providers })`
> rewrite, both refused). It is the panel-synthesized authoritative shape and it REFINES
> decisions A, C, D, and G (the codec rides the column by value; the daemon observes body
> docs). Where this section and an older decision body disagree, this section governs.

The design is a tripartition. Each concern is owned by exactly one layer and never leaks
into the others:

```txt
SCHEMA owns the GUID    ·    APP owns the BYTES (codec)    ·    RUNTIME owns the LIFECYCLE
```

```txt
YJS DOC GRAPH (every doc is a separate top-level guid-addressed Y.Doc; NO subdocs, fact 7)

  ROOT Y.Doc  guid = "epicenter-fuji"
    EncryptedYkvLww tables.entries   (row VALUES = ciphertext-in-doc; NO body column stored)
      row k7x9 = { id, title, updatedAt }
           |
           |  bodyDocGuids({ workspaceId, tables, rows })   <- PURE FN, not a stored edge
           v
  BODY Y.Doc  guid = "epicenter-fuji.entries.k7x9.content"   (PLAINTEXT-in-doc; enc only at-rest IDB)
    richText():  getXmlFragment('content')        fuji / honeycrisp
  BODY Y.Doc  guid = "epicenter-opensidian.files.f12.content"
    timeline():  getArray('timeline')             opensidian (same machine, different codec)

THE THREE SEPARATELY-OWNED VALUES THAT COMPOSE

  SCHEMA  content: column.body(richText())  --partition-->  definition.bodies: [{ field, codec }]
                                                            bodyDocGuids(...) : BodyRoom[]   (pure)
  APP     codec = { attach(ydoc): { read(): string } }      richText() | timeline()  (carried by value)
  RUNTIME browser: attachBodyCache (refcount + grace)        daemon: replicateBodies (stream + observe)
          |__________ SHARE the per-doc attach(open) _________|   NOT shared: lifecycle, touch, trigger
```

### 1. Schema: `column.body(codec)`

```ts
// A body codec is an ISOMORPHIC descriptor that lives in @epicenter/workspace beside
// attachRichText. Its ONLY required contract is read(): string (for materialization);
// the app also reads .binding / mode handles off it for the editor. Carried BY VALUE.
type BodyCodec<THandle extends { read(): string }> = { attach(ydoc: Y.Doc): THandle };

export const richText = (): BodyCodec<RichTextAttachment> => ({ attach: attachRichText });
export const timeline = (): BodyCodec<Timeline>          => ({ attach: attachTimeline });

const entriesTable = defineTable({
  id:      column.string<EntryId>(),
  title:   column.string(),
  content: column.body(richText()),     // fuji / honeycrisp
  // content: column.body(timeline()),  // opensidian: SAME machine, different codec
});
```

`column.body(codec)` returns a branded marker `{ [BODY]: codec }`, NOT a `TSchema`.
`defineTable` runs ONE partition step (the only new table behavior):

```txt
columns --partition--> dataColumns -> schema / RowOf / SQLite DDL / frontmatter   (UNCHANGED path)
                     \  bodyColumns -> definition.bodies: { field, codec }[]       (NEW)
```

- The column KEY is the docGuid `field` segment (`content` -> `'content'`): no second
  source of truth, no free `field` argument.
- The row type Omits body keys (`Static` of `column.body()` is `never`): the body never
  appears on the row, in `Value.Check`, in the SQLite DDL, or in default frontmatter.
- Why the codec rides the schema (refines decisions A/C): both `attachRichText` AND
  `attachTimeline` already expose `read(): string` over a bare Y.Doc
  (`attach-rich-text.ts:36`, `attach-timeline/timeline.ts:146`). A one-method codec
  carried by value lets the generic daemon read ANY app's body with zero per-app
  threading and ZERO reader-registry. This is what lets opensidian's timeline be a
  first-class citizen instead of a deferred special case. The codec choice IS part of the
  wire contract (peers must agree the body holds `getXmlFragment('content')` vs
  `getArray('timeline')`), so it belongs in the schema by the same logic that puts column
  types there, dispatched by `codec.attach(ydoc).read()`, never a `switch` or a tag.

### 2. Derivation: `bodyDocGuids` (pure, every runtime calls it identically)

```ts
type BodyRoom = {
  guid: Guid;            // docGuid({ workspaceId, collection: table, rowId, field })
  table: string;
  rowId: string;
  field: string;
  codec: BodyCodec<{ read(): string }>;
};

function bodyGuid(a: { workspaceId: string; table: string; rowId: string; field: string }): Guid;
function bodyDocGuids(a: { workspaceId: string; tables: Tables; rows: ... }): BodyRoom[];
//   for each table, each { field, codec } in definition.bodies, each row -> one BodyRoom
//   No I/O, no keyring. Enumerates from PLAINTEXT row keys (decision K).
```

Parity invariant (Phase 0 proves it first): `bodyGuid(...) === entryContentDocGuid(rowId)`,
so existing bodies are found at their current rooms: NO data move.

### 3. Browser: `attachBodyCache` (lazy, refcount + grace)

```ts
const bodies = attachBodyCache(workspace, {
  // the per-doc provider attach, supplied once; same primitives the root uses
  open: (ydoc) => ({
    idb:  attachLocalStorage(ydoc, { server, ownerId, keyring }),     // per-guid HKDF (decision E)
    sync: openCollaboration(ydoc, { url: roomWsUrl({ guid: ydoc.guid }), waitFor, actions: {} }),
  }),
  // touch: app-supplied so it owns the clock TYPE (ISO DateTimeString vs epoch number);
  //        BROWSER-ONLY (the daemon opener has no touch param, so it cannot write rows)
  touch: ({ table, rowId }) => tables[table].update(rowId, { updatedAt: DateTimeString.now() }),
});

const handle = bodies.body('entries', entryId);  // derive guid -> open via cache -> codec.attach(ydoc)
handle.read();      // body -> plaintext (export / preview)
handle.binding;     // editor binding: XmlFragment (richText) or timeline (opensidian)
```

Build closure: `new Y.Doc({ guid, gc:true })` -> `codec.attach(ydoc)` -> `open(ydoc)` ->
`onLocalUpdate(ydoc, () => touch({ table, rowId }))`. This is fuji's current
`entryContentDocs` builder, generalized. Replaces the three hand-wired per-app caches.

### 4. Daemon: `replicateBodies` (streaming AND body-observing)

```ts
const bodies = replicateBodies({
  rooms: () => bodyDocGuids({ workspaceId, tables, rows: tables }),  // recompute on membership change
  open:  (ydoc) => attachProjectSync(ydoc, { ..., actions: {} }),  // yjs-log + sync
  materialize: (room, text) => markdown.writeBody(room.table, room.rowId, text),
  concurrency: 8,
});
// per room: open ydoc -> await infra.collaboration.whenConnected
//           -> text = room.codec.attach(ydoc).read()
//           -> materialize(room, text)                                          [initial]
//           -> ydoc.observe(debounce(() => materialize(room, room.codec.attach(ydoc).read())))  [steady]
// membership: tables.observe on the ROOT adds a new row's body, drops a hard-deleted body;
//             it NEVER re-reads existing content.
// scale: bounded concurrency + an LRU cap on live bodies; cold bodies read-once-and-destroy.
```

THE LOAD-BEARING RULE (refines decision G): **`updatedAt` is CONTENT, not membership.** It
never enters `bodyDocGuids`; the daemon never reads it. The daemon re-materializes ONLY
when the body doc's OWN update stream fires (`ydoc.observe`), so the out-of-order arrival
of a body update vs its row's `updatedAt` bump (separate rooms, fact 4) can never corrupt
the output. A one-shot read plus "re-read because `updatedAt` changed" is the exact bug
this rule forbids: the markdown materializer's only existing re-trigger is `table.observe`
(`materializer.ts:353`), so without a body observer a body-only edit leaves `.md` stale.

### 5. Materializer: a second input axis (a real contract change, not a no-op)

`toMarkdown(row)` stays the FRONTMATTER source. The body is a SEPARATE input, re-fired on
the body doc's update stream, joined by `assembleMarkdown(frontmatter, bodyText)`. The
markdown materializer grows a body-text source per table beside the existing row observer.
Priced as a Phase 3 risk, not an additive piece.

### createWorkspace stays (decision I)

Root construction is unchanged; `definition.bodies` surfaces on each `tables[name]` so
consumers can derive. No `openWorkspace(schema, { providers })` unification (it would
re-merge the browser/daemon asymmetry decision G keeps apart). Two honest openers
(root-open already exists, add body-open), sharing ONLY the per-doc `open` attach.

---

## Refusals recorded (per greenfield-clean-breaks)

```txt
Candidate:  workspace.docs registry + createDocCache + attachWorkspaceProviders
Refusal:    a global doc registry with a lazy synchronous-notify invariant, a role
            discriminator (fake symmetry), and a whenLoaded round-trip through get(guid)
            that exists only to re-expose a handle the redesign deleted. It pays for the
            dedup nicety (P2), not the real capability (P1).
User loss:  "one call attaches to every doc" framing. Recovered differently: the schema
            derivation gives every runtime the doc set without a registry.
Trigger to revisit: a runtime that receives a workspace WITHOUT its schema and must
            discover docs at runtime. None exists today.

Candidate:  inject attachChildDoc(ydoc) into each iso factory's child cache
Refusal:    still threads runtime providers through a per-app lazy cache the daemon does
            not want; standardizing the param helps but keeps the cache as the unit. The
            schema declaration removes the need to thread anything: the doc set is data.
User loss:  none material; this was strictly better than the registry but still
            cache-centric.
Trigger to revisit: if schema-level derivation proves too invasive to land and a smaller
            interim is needed, the standardized attachChildDoc is the fallback.

Candidate:  serialized Yjs shared type (Y.XmlFragment / Y.Text) inside a YKV row value
Refusal:    PROVEN impossible, not just undesirable. The YKV row value is JSON.stringify'd
            and XChaCha-encrypted before it enters the Y.Array; a shared type stored that
            way is ContentAny dead data (Yjs Q1), and the LWW store re-stamps + replaces
            the whole value on every write so concurrent body edits clobber wholesale
            instead of merging (Yjs Q2). Bodies attach BY NAME on a Y.Doc, never as a row
            value.
User loss:  none. There was never a working version of this.

Candidate:  Yjs subdocuments (Y.Doc nested in the parent via a Y.Map ContentDoc)
Refusal:    Subdocs add a per-body ContentDoc reference in the parent: a second source of
            truth for "which bodies exist" that must stay consistent with the rows. The
            deterministic guid already derives the doc set from rows with no parent
            references (Yjs Q4). The relay, room router, IDB persistence, and yjs-log are
            all guid-addressed today (fact 7); subdocs would force them to learn
            parent/child relationships for zero benefit.
User loss:  Yjs-native autoLoad/shouldLoad lazy loading. Recovered: the browser
            disposable cache + the daemon stream already give lazy/streamed loading.

Candidate:  role: 'root' | 'body' discriminator on a shared provider factory
Refusal:    Root and body docs are opened by DIFFERENT call sites with different needs:
            the root opener passes workspace.actions; the body opener ALWAYS passes
            actions: {} (a body never hosts actions). They share no branch that needs a
            discriminator. A role tag would be a dumping ground waiting to grow as doc
            kinds are added. Keep two explicit openers that share the per-doc attach.
User loss:  the "one factory, one role flag" framing. Recovered: explicit asymmetric
            openers (decision F + G), which is the project's stated preference.

Candidate:  asserting bodies are end-to-end confidential because rows are
Refusal:    Rich-text bodies are value-encrypted NOWHERE (fact 6). They are plaintext on
            the wire to the relay and in the daemon yjs-log, today, for fuji. column.body()
            and column.text() do not change this. Do not let "rows are encrypted" leak
            into a false belief that bodies are. Body E2E is a separate update-stream
            encryption project.
User loss:  none (this is a correction, not a feature removal).
```

---

## Decisions (resolves the prior open questions)

### A. The exact semantics of column.body()

> AMENDED by "The new API": column.body() takes a CODEC by value, e.g.
> `column.body(richText())` or `column.body(timeline())`. Read "rich-text Y.Doc via
> attachRichText" below as the `richText()` case; the body root is whatever the codec
> attaches. `definition.bodies` carries `{ field, codec }`, not bare field names.

```txt
Decision:
  column.body() is a COLUMN with an external storage class: "DOC" (a separate
  top-level rich-text Y.Doc) instead of TEXT/INTEGER/REAL (inline). The column KEY is
  the body's `field` segment in docGuid. It declares, for each row of that table:
  "there is a rich-text body at docGuid(workspaceId, <table>, <rowId>, <columnKey>),
  whose root is a Y.XmlFragment via attachRichText." It carries NO value in the stored
  row payload (the guid is derivable; nothing is persisted inline), so the table layer
  partitions it out: it is absent from the user-facing row type, from the stored
  payload, from Value.Check, from the SQLite DDL, and from default markdown
  frontmatter. defineTable collects body columns into `definition.bodies` (the field
  list); the doc set is `definition.bodies x rows`, derived identically everywhere.

Why:
  - The column KEY must equal the docGuid `field` segment ('content' for fuji), and
    field names already live in the columns record, so declaring it there reads next
    to column.string() and keeps one blessed place for field names.
  - It cannot be a normal column: a body is not a flat JSON value (it is a separate
    CRDT doc), so it must NOT flow through FlatJsonTSchema/deriveStorage as TEXT, must
    NOT appear in RowOf, and must NOT be stored inline (Yjs Q1/Q2: a shared type cannot
    survive as a row value). Modeling it as a fourth storage class ("this column's
    value lives in a related doc, not in the row") is the honest description and
    localizes all special-casing to ONE place: defineTable's partition step. Every
    downstream consumer (row type, SQLite, markdown, sync) sees the partitioned data
    schema and never learns about bodies.

Refused:
  - column.body() as a stored column that round-trips an empty/placeholder value:
    pollutes RowOf and the SQLite DDL with a dead field and invites "why is this column
    always empty" confusion.
  - A free `field` argument (column.body('content')): redundant with the column key and
    a second source of truth that can disagree with it. The key IS the field.
  - A separate top-level `bodies:` key on defineTable (parallel to the columns record):
    considered and kept as the fallback if the partition leaks special-casing beyond
    the table layer. Rejected as the default only because column.body() reads better
    and the partition is a single localized step. If body fields ever need more than a
    field name (root-type tags, per-body options), promote to the explicit `bodies:`
    key rather than overloading the columns record.
```

### B. Should column.text() exist? (decision: not in this round)

```txt
Decision:
  No. Do not add column.text() now. If it is ever added, it means specifically "a
  top-level Y.XmlFragment on the ROOT doc, named by (table, rowId, field)" (live rich
  text in the root), and NOTHING else.

Why:
  Each candidate meaning is either redundant or dishonest:
  - "plain inline text" is already column.string(). Adding text() for it is a duplicate
    verb.
  - "serialized editor JSON" is column.json(EditorSchema): a STATIC snapshot, not a
    CRDT. Under LWW it clobbers wholesale on concurrent edits (Yjs Q2). Naming that
    text() implies a live collaborative body it does not deliver.
  - "inline root-doc Y.XmlFragment" is the only meaning that is genuinely live rich
    text. It is technically possible (a named top-level fragment per row), but it is
    NOT a cheap sibling of column.body(): it is a SECOND body mechanism with its own
    derivation, its own row-delete cleanup (a named top-level type is only GC'd when
    explicitly emptied, so deleting a row must delete its fragment or the root doc
    accumulates orphans forever), and the all-or-nothing root load + per-keystroke root
    update stream (Yjs Q3). The spec earlier framed text() as "delete the child
    machinery"; in fact it ADDS a parallel root-fragment machine while only deleting
    per-body sync granularity.
  - The encryption argument does NOT favor inline either: bodies are not value-
    encrypted in either shape (fact 6), so inline is not "less safe" than child, but it
    is not "more contained" the way the spec implied.

Refused:
  - column.text() == column.json snapshot dressed as live text.
  - column.text() == column.string alias.
  - Shipping inline bodies as a "limiting case that deletes child machinery": it is a
    separate machine, not a deletion. Earn column.body() first; reconsider inline only
    when a concrete bounded app (a small journal) proves the root-load cost is fine and
    accepts the orphan-cleanup obligation.
```

### C. column.doc() as a more general primitive? (decision: body() first)

> AMENDED by "The new API": the codec-by-value (`column.body(timeline())`) IS the general
> case, and it costs NO reader-registry: the codec carries `read(): string` by value,
> dispatched by polymorphism. So opensidian's timeline ships WITH this feature, not
> deferred. The "known Y.XmlFragment root" framing below is superseded: the known contract
> is `read(): string`, which `attachRichText` AND `attachTimeline` both already satisfy
> (`attach-rich-text.ts:36`, `attach-timeline/timeline.ts:146`). A separate `column.doc()`
> verb is still refused, because `column.body(codec)` subsumes it.

```txt
Decision:
  Ship column.body() (rich-text body, known Y.XmlFragment root) as the earned narrow
  feature. Do NOT introduce a general column.doc() (a child doc of arbitrary shape) now.

Why:
  The whole win is that EVERY runtime reads a body the SAME way with zero app code. That
  requires a KNOWN root shape: a Y.XmlFragment the generic daemon can xmlFragmentToPlaintext
  (fact 5). A general column.doc() with an unspecified root cannot be read generically:
  it would need an app-supplied reader, which re-introduces exactly the per-app
  threading this spec deletes. body()'s generality is real and free; doc()'s generality
  is speculative and costs a reader-registry.

Refused:
  - column.doc() now. Revisit only if a non-rich-text child doc need appears (embedded
    sheet, whiteboard), and then with an EXPLICIT schema-declared root-type tag
    (column.doc({ root: 'xmlFragment' | 'map' })) plus a registered reader per root
    kind. Until then doc() is unearned generality.
```

### D. Body edit -> row.updatedAt without coupling the editor to app tables

> AMENDED by "The new API": the touch VALUE is app-supplied (a `touch` closure on
> `attachBodyCache`), not a library default `now()`, because the stamped TYPE differs per
> app (fuji/honeycrisp ISO `DateTimeString` vs opensidian epoch number: one library clock
> cannot pick). The touch is BROWSER-ONLY by construction (the daemon opener has no
> `touch` param, so it cannot write rows). The rest of D stands: `onLocalUpdate`'s
> `tx.local` filter means hydration/remote sync do not bump; the editor never imports a
> table.

```txt
Decision:
  column.body() owns the bump generically. The generic body open registers
  onLocalUpdate(bodyYdoc) -> workspace.tables[<table>].update(<rowId>, { updatedAt:
  now() }), defaulting to the conventional `updatedAt` column when the table has one,
  no-op otherwise. Opt out with column.body({ touch: false }). The editor (Tiptap/
  ProseMirror binding) never references a table: it only mutates the fragment.

Why:
  - The body column knows its owning (table, rowId) by construction (the derivation key
    + the schema declaration), so the bump is fully generic: it goes through the
    generic Table.update API, never an app-specific table handle.
  - onLocalUpdate already filters transaction.local (semantic, not origin-shape based),
    so IndexedDB hydration and remote/sync body updates do NOT bump updatedAt: only a
    real local edit does. This is exactly fuji's existing wiring (index.ts:144), lifted
    into the generic body opener.
  - This deletes fuji's hand-wired onLocalUpdate from createFuji.

Refused:
  - Editor code importing the table to bump updatedAt: couples editor to app schema.
  - A bump baked into the relay/sync layer: the relay must not write rows.
```

### E. Keyring / decryption through a generic openBody

```txt
Decision:
  The generic body open threads the keyring EXACTLY as fuji does today: attachLocalStorage(
  bodyYdoc, { server, ownerId, keyring }) (per-guid HKDF, fact 6b) + openCollaboration(
  bodyYdoc, { ..., actions: {} }). No new keyring path; the per-doc derivation already
  keys off bodyYdoc.guid. Same call in the browser cache and the daemon sweep.

Why:
  Body docs have no YKV value layer, so their at-rest confidentiality comes entirely
  from attachEncryptedIndexedDb's per-guid update-byte encryption, which is identical
  whether the doc is a root or a body. The generic opener simply calls the same
  attach* primitives on the body ydoc.

Refused:
  - Any claim that column.body() (or column.text()) makes body content confidential
    from the relay. It does NOT (fact 6): rich text syncs as plaintext updateV2 bytes
    and is plaintext in the daemon yjs-log. This is already true for fuji today. If
    body confidentiality from the relay is required, that is a SEPARATE project
    (end-to-end encrypt the update stream), orthogonal to the column surface, and must
    not be smuggled in as a side effect of this design. Recording it here so nobody
    later assumes bodies are E2E encrypted because rows are.
```

### F. Browser lazy opening and caching

```txt
Decision:
  One generic library cache = createDisposableCache keyed by body guid, built from a
  provider factory supplied once per runtime. The build closure mirrors fuji's current
  entryContentDocs: new Y.Doc({ guid, gc: true }) -> attachRichText -> attachLocalStorage
  (keyring) -> openCollaboration(actions: {}) -> onLocalUpdate bump (decision D). A
  generic accessor workspace.body('<table>', rowId) derives the guid from
  definition.bodies and opens via the cache. Refcount + gcTime grace already handle
  route swaps / split-pane reopen.

Why:
  This is a 1:1 generalization of the three hand-wired per-app caches into one library
  mechanism parameterized by (schema-derived guid, provider factory). The disposable
  cache is explicitly designed for shared, stateful, expensive-to-build Y.Docs
  (disposable-cache.ts doc). The deletion prize (3 caches -> 1) is real.

Refused:
  - Threading providers through the iso factory (createFuji). The iso factory declares
    schema + actions only; the browser cache and its providers live in the browser
    composition (openFujiBrowser), not in the wire-contract module.
```

### G. Daemon batch sweep without a cache

> AMENDED by "The new API": the daemon is a streaming replicator that ALSO OBSERVES each
> live body doc and re-materializes on the body's OWN update stream. "Read then destroy"
> is the COLD-body path only; hot bodies stay live under a bounded LRU and re-emit on
> edit. The load-bearing rule: `updatedAt` is CONTENT, not membership, so the daemon never
> re-reads a body because `updatedAt` changed (the separate-room ordering trap). Root-table
> observation drives MEMBERSHIP only (add/drop bodies), never content refresh. Without the
> body observer, a body-only edit leaves `.md` stale (`materializer.ts:353` only re-fires
> on `table.observe`).

```txt
Decision:
  The daemon does NOT reuse the browser cache. It STREAMS: for each (table, body field,
  row) derive the guid, build a bare Y.Doc, attachYjsLog (persist) + openCollaboration(
  actions: {}) (sync), wait for load/first sync, read the fragment for the materializer,
  then DESTROY the doc before moving on, with small bounded concurrency. It also
  observes the root table: a new row opens+syncs its body; row lifecycle drives the
  sweep set (decision H). The daemon and browser SHARE the per-doc provider attach
  (attach storage + sync to a body ydoc) but NOT the lifecycle manager.

Why:
  Browser and daemon are honestly different operations. The browser holds a body live
  while the UI references it (refcount + grace); the daemon must NOT hold every body
  live at once (opensidian: a large vault with many large files would exhaust memory).
  Forcing one cache abstraction with a "release policy" flag would be a mode
  discriminator over two unlike lifecycles. Two mechanisms, one shared attach, is the
  honest asymmetry.

Refused:
  - One cache with a daemon "release-immediately" policy flag: fake symmetry over two
    different lifecycles.
  - The daemon instantiating the app iso factory's browser cache (today it builds
    createFuji and lets the child cache sit inert): the daemon takes schema + actions +
    materializers, derives the doc set, and sweeps. No app-specific mount open(ctx).
```

### H. Room-listing API? (decision: no; derive from rows)

```txt
Decision:
  No cloud room-listing API. The daemon derives its sweep set from the root rows
  (definition.bodies x rows). For row lifecycle: a created row adds its body to the
  sweep; a soft-deleted row (deletedAt) keeps syncing its body (it can be restored); a
  hard-deleted row (gone from the table) drops out of the derived set, so the daemon
  stops syncing it. Cloud state for a dropped body is left as-is (the relay GC / a
  separate retention policy owns cloud cleanup, not the per-sweep derivation).

Why:
  Fact 4: no enumeration of rooms exists anywhere, and derivation from the root makes
  one unnecessary. The pure function rows -> guids fully covers "which bodies should
  this daemon sync." A body whose row was hard-deleted but whose doc still has cloud
  state is intentionally NOT chased by the sweep: resurrecting orphan cloud docs would
  re-introduce a non-derivable doc set.

Refused:
  - A server "list rooms for owner" endpoint to discover bodies: re-introduces a second
    source of truth for the doc set that can drift from the rows.
```

### I. createWorkspace vs openWorkspace(schema, { providers })

```txt
Decision:
  Do NOT rewrite createWorkspace into openWorkspace(schema, { providers }). The
  data-model / runtime split this spec wants ALREADY exists structurally: createWorkspace
  builds the encrypted root doc (data model + encryption), and the attach* primitives add
  runtime (storage, sync, materializers) on top. The body work fits that seam with four
  additive pieces and a near-zero change to createWorkspace's surface:
    1. defineTable partitions column.body() into definition.bodies (decision A).
    2. a PURE derivation helper bodyDocGuids({ workspaceId, schema, rows }) (and a
       per-row bodyGuid(...)) in packages/workspace.
    3. a generic browser body-cache attach (decision F).
    4. a generic daemon sweep (decision G).
  createWorkspace continues to return the root bundle; it merely also surfaces the
  declared body fields (via definition.bodies on each table) so consumers can derive.

Why:
  A big-bang openWorkspace(schema, { providers }) rewrite would touch the root open path
  for every app at once for no capability the additive seam lacks. The providers differ
  per runtime (browser cache vs daemon stream), so folding them into one open signature
  would force a discriminator anyway. Keep the root construction stable; add the body
  pieces beside it.

Refused:
  - openWorkspace(schema, { providers }) as a unifying rewrite: large blast radius, and
    it would re-merge the browser/daemon provider asymmetry that decision G keeps apart.
```

### J. Inline column.text() storage semantics

```txt
Decision:
  Settled by Yjs Q1/Q2 and decision B. Inline rich text CANNOT be a Y.XmlFragment (or
  any shared type) stored "under a key in the root doc keyed by rowId" as a YKV row
  value: the YKV row value is a JSON.stringify'd (and encrypted) plain object, and a
  shared type does not survive that (it becomes dead data and LWW clobbers it). The only
  coherent inline shape is a SEPARATE top-level Y.XmlFragment on the root doc, named per
  (table, rowId, field), living OUTSIDE the YKeyValueLww row storage entirely. That is a
  parallel body mechanism (decision B), not a row-storage feature, and it is refused for
  this round.

Why:
  See Yjs Q1 (no shared type as a row value), Q2 (serialized snapshot is not a CRDT),
  Q3 (one giant root doc = all-or-nothing load + every keystroke in the root stream).

Refused:
  - "inline rich text == Y.XmlFragment inside the YKV row value": physically impossible
    in the current storage model and semantically broken even if forced.
```

### Migrations / versioning note (the earlier sub-question C)

```txt
defineTable is versioned (v1/v2/migrate); adding column.body() to the latest version is
additive and needs no data move, because the body doc set is DERIVED from rows at the
deterministic guid that already matches existing storage (the prototype proves parity
before any rollout, fact 1). A future inline->child migration (if column.text() ever
ships) would be a real data MOVE (copy a root fragment's content into a child doc at the
derived guid, then delete the root fragment) and would need its own one-time migration
action, not a defineTable migrate() step. Out of scope until column.text() is earned.
```

### K. Body doc identity: derived namespaced guid, NOT a stored id

```txt
Decision:
  Keep the DERIVED guid (docGuid(workspaceId, table, rowId, field)). Do NOT store a body
  id on the row (a generateGuid() FK-style pointer per body field). The body's location
  stays a pure function of data the row already has.

Why:
  - rowId is nanoid10, TABLE-scoped, NOT globally unique (id.ts:52 says so outright). The
    namespace prefix (workspaceId.table) is what makes a 10-char id safe as a GLOBAL room
    name: it is load-bearing, not decoration. A stored scheme would have to mint a
    globally-unique generateGuid() (15-char) per body instead, just to drop a prefix that
    is already cheap (~40 lines of pure injective composition in doc-guid.ts that also
    buys readable room names and a latent prefix-enumeration capability).
  - Derived is a TOTAL function: every row has a derivable body guid with NO write step.
    A stored pointer is PARTIAL: every row-create site must mint and write the id, and
    forgetting once yields a bodyless row (a brand-new failure mode). You do not store
    what you can deterministically compute.
  - In Yjs there is no "exists": a guid ALWAYS names a (possibly empty) doc. The stored
    scheme's "populate the id even if the doc doesn't exist, then lazy-load depending on
    whether it exists" is SQL-FK thinking that the derivation makes unnecessary: you just
    open the derived guid; it is empty until written.
  - Migration: a derived body field is FREE for existing rows (the guid already matches
    existing storage, fact 1). A stored scheme forces relocating every existing body doc
    to a new id-named room, or backfilling the old derived guid as the "id" (pointless).
  - Enumeration: derived reads the PLAINTEXT row key; a stored id is an ENCRYPTED row
    value (fact 6a), so listing the doc set would suddenly require the keyring.
  - The intrinsic-identity draw of the stored scheme is already had: row ids are IMMUTABLE
    nanoids, so the derived body guid is as stable as the row's own id. "Rename the row ->
    orphan the body" never happens because you never rename an immutable id.

Refused:
  - Storing a global body id on the row.
Trigger to revisit:
  - Bodies that must be DECOUPLED from their row: re-parented to another row, shared
    across rows, or kept alive after a hard-delete and re-attached. No app's model needs
    this today; the day a "detachable / re-parentable document" feature appears, the
    stored intrinsic id becomes necessary and this decision flips for that field.
```

---

## Rough phased plan (prototype-first; do NOT start the multi-app wave cold)

```txt
Phase 0  PROTOTYPE on Fuji only, throwaway-friendly. Prove the derivation end to end:
         column.body() on entries.content -> generic body open in the browser ->
         generic daemon sweep that persists + materializes a body. Answer open
         questions B, D, E, F against real code before committing to a surface.

Phase 1  The column surface (column.body / column.text) + the schema-level derivation
         helper "doc set of a workspace" in packages/workspace. Tests on the pure
         derivation (rows -> guids).

Phase 2  Generic browser body cache + provider factory; replace fuji's hand-wired
         entryContentDocs. Prove parity (editing a body still syncs).

Phase 3  Generic daemon replicator; replace fuji's per-app mount open(ctx). Prove the
         daemon persists + materializes bodies (the manifest spec's blocked capability).

Phase 4  Roll to honeycrisp + opensidian. Evaluate column.text() (inline) per field;
         opensidian stays column.body().

Phase 5  DELETE: the 3 guid functions, the 3 hand-wired caches, the per-app daemon
         mount wiring, and (now unbuilt) the registry/decorator designs from the prior
         specs.
```

## Phase 0 prototype plan (Fuji only, exact files + proof)

Throwaway-friendly. Goal: prove the derivation loop end to end on Fuji and confirm
decisions B, D, E, F, G against real code BEFORE touching honeycrisp/opensidian or the
type-level partition rigorously. Lean on runtime partitioning; keep the type surface
loose where it only costs prototype polish.

```txt
The loop to prove:
  column.body() on entries.content
    -> defineTable partitions it; bodyGuid derives docGuid(FUJI_ID,'entries',id,'content')
    -> browser: generic body cache opens it lazily, edits persist + bump updatedAt (B,D,E,F)
    -> daemon: generic stream opens the derived body, syncs/persists, reads plaintext,
       materializes it into the entry's markdown body (G)
```

### Exact files to touch

```txt
ADD (library, generic):
  packages/workspace/src/document/column/sugar.ts
     + body(): returns a recognizable marker (e.g. { [BODY_MARKER]: true, kind: 'doc' });
       add `body` to the `column` namespace. Smallest honest sentinel; not a TSchema.
  packages/workspace/src/document/column/constraint.ts
     allow the body marker as a column value (do not run FlatJsonTSchema on it).
       Prototype: a loose union at the columns parameter type is enough.
  packages/workspace/src/document/define-table.ts  (+ table.ts)
     partition columns: collect body field names into definition.bodies: string[];
     build `schema` / RowOf from the data columns only. Runtime filter is enough for P0.
  packages/workspace/src/document/body-doc-set.ts   (NEW, pure)
     bodyGuid({ workspaceId, table, rowId, field }) -> docGuid(...)
     bodyDocGuids({ workspaceId, schema, rows }) -> Guid[]   (definition.bodies x rows)
     This is the single derivation every runtime calls. No I/O.

ADD (browser generic open) and EDIT fuji:
  packages/workspace/src/document/attach-body-cache.ts   (NEW)
     attachBodyCache(workspace, { open }) -> createDisposableCache keyed by body guid;
     build closure runs the caller-supplied per-doc `open(bodyYdoc)` (storage + sync +
     attachRichText) and wires onLocalUpdate -> tables[table].update(rowId,{updatedAt}).
     Exposes workspace.body(table, rowId) (or .body(table, rowId, field)).
  apps/fuji/src/lib/workspace/index.ts
     entriesTable latest version: add `content: column.body()`.
     createFuji: DELETE the hand-wired entryContentDocs + onLocalUpdate + the
     entryContentDocGuid usage inside the factory (guid now derived). Keep
     entryContentDocGuid exported only until Phase 5 (parity assertion target).
  apps/fuji/src/lib/workspace/browser.ts
     replace the hand-wired entryContentDocs build with attachBodyCache(workspace, {
       open: (ydoc) => ({ idb: attachLocalStorage(ydoc,{...}),
                          sync: openCollaboration(ydoc,{ ..., actions:{} }) }) }).

ADD (daemon generic stream) and EDIT fuji:
  packages/workspace/src/daemon/sweep-bodies.ts   (NEW)
     sweepBodies({ workspaceId, schema, rows, openBody, read }): for each derived guid,
     build a bare Y.Doc, attachYjsLog + openCollaboration(actions:{}), await load, read
     the fragment plaintext, destroy; bounded concurrency. Returns rowId -> bodyText.
  apps/fuji/src/lib/workspace/project.ts
     in open(ctx): after the root is built, derive body guids from schema + rows and feed
     sweepBodies; pass the per-row body text into the markdown materializer's
     perTable.entries.toMarkdown so the .md body is the rich-text plaintext (today this
     is hand-wired in markdown.ts via host.entryContentDocs).
```

### Smallest proof

```txt
1. Pure parity unit test (no cloud, no fs) -- the cheapest decisive check:
     packages/workspace/src/document/body-doc-set.test.ts
     For a fuji-shaped schema + a row id, assert
       bodyGuid({ workspaceId: FUJI_ID, table:'entries', rowId, field:'content' })
       === entryContentDocGuid(rowId)   // the existing hand-wired guid
     This proves derivation matches existing storage: NO data move (risk item).
     Run: `bun test packages/workspace/src/document/body-doc-set.test.ts`

2. In-process loop test (proves B, D, E, F, G without a real relay):
     - createWorkspace({ id: FUJI_ID, keyring: testKeyring, tables:{ entries } })
     - tables.entries.set(one row)   // updatedAt = t0
     - open its body via attachBodyCache; write "hello\nworld" into the fragment locally
     - assert tables.entries.get(id).updatedAt advanced past t0   (decision D bump)
     - run sweepBodies over [row] with an in-memory openBody that shares the same ydoc
       bytes; assert the read plaintext === "hello\nworld" via xmlFragmentToPlaintext
       (decision F/G read; block-aware newline)
     - assert the markdown body produced for the row === that plaintext
     Run: `bun test` in packages/workspace (and apps/fuji for the materializer wiring)

3. Manual end-to-end (optional, confirms real sync/persist):
     In an examples/fuji project: create an entry in the browser, type a body, confirm
     it persists across reload (IDB) and the body guid in devtools === docGuid(...).
     Then `epicenter daemon up` and confirm the generated entry .md contains the body
     text (daemon sweep materialized it). This is the capability the manifest spec was
     blocked on.
```

Decisions exercised: A (partition + derived guid), B/D (updatedAt bump via onLocalUpdate),
E (keyring threaded through attachLocalStorage on the body ydoc), F (browser lazy cache),
G (daemon stream, no cache). H/I/J/K are settled by design above and need no Phase 0 code.

Scope notes for Phase 0 (so the prototype is not mistaken for the final shape):
  - Phase 0 uses richText() only (fuji); attachBodyCache + sweepBodies still take the codec
    from definition.bodies so the timeline() path is structurally present, just unexercised.
  - Phase 0's daemon does the one-shot read (build -> read -> destroy) to PROVE the
    derivation + materialize loop. The steady-state body OBSERVER + bounded LRU + the
    DaemonRuntime multi-collaboration rewrite (the G amendment + the new-API section) are
    Phase 3 work, not Phase 0. Do not ship the one-shot sweep as the real daemon.

## Deletion prize (what disappears if this lands)

```txt
- entryContentDocGuid / noteBodyDocGuid / fileContentDocGuid (3 per-app guid fns)
- the 3 hand-wired child caches in the iso factories
- the 3 wrapping caches in the *.browser.ts files
- the entire registry / attachChildDoc / createDocCache / attachWorkspaceProviders idea
- per-app daemon mount open(ctx) code -> one generic mount runner
- the daemon's "cannot persist children" gap (it derives + syncs the set)
The 3 per-app browser caches collapse into ONE generic library cache (generalized, not
deleted: decision F). column.text() is deferred (decision B), so the "child docs vanish
completely" prize is NOT claimed in this round.
```

## Risks

```txt
- Schema/library blast radius. The win is at the schema layer (correct), but that means
  touching defineTable, the workspace open path, and all three apps in one direction.
  Mitigate with Phase 0 prototype + phased rollout.
- column.text() is a per-app size judgment, not a blanket conversion. Opensidian must
  stay column.body(). Wrong inlining bloats the root doc + kills sync granularity.
- Durable data: existing bodies already live at docGuid(...) rooms, so derivation
  matches existing storage; no data move expected. CONFIRM via the Phase 0 parity test
  before Phase 5.
- The reverse dependency (B) and the keyring thread (E) are the two correctness items
  most likely to bite; the Phase 0 in-process loop test resolves both.
- Body confidentiality (fact 6): bodies are plaintext to the relay and the daemon log
  TODAY. This design does not change that and must not claim to. If a user expects
  bodies to be as private as rows, that is a real gap, but it is a SEPARATE
  update-stream-encryption project, not a blocker for column.body(). Flag it so the
  decision is made consciously, not discovered later. NOTE this design OPERATIONALIZES
  the exposure: the daemon now systematically materializes every body to plaintext on
  disk (like the .md files already are). Decide consciously: accept as local-machine
  projection, or gate behind body update-stream encryption.
- Materializer body-input axis (Phase 3, a real contract change, not a no-op). toMarkdown(row)
  owns frontmatter today; the body becomes a SECOND input re-fired on the body doc's update
  stream, joined by assembleMarkdown. fuji's browser round-trips the body THROUGH
  toMarkdown/fromMarkdown (markdown.ts); if the daemon's frontmatter+body split desyncs from
  that shape, daemon .md and browser .md diverge. Prove the shapes match in the Phase 0
  in-process loop before the multi-app wave.
- DaemonRuntime rewrite (Phase 3, the largest blast radius). types.ts:54 exposes ONE
  collaboration per mount; replicateBodies turns the mount into a replicator over N docs with
  a bounded hot-set, touching the daemon socket app's served surface (/peers, /list, /invoke).
  The root collaboration stays the served one; the body replicator is internal mount state.
  Specify the collaboration.whenConnected wait point (NOT a non-existent firstSync; the
  yjs-log has no whenLoaded) plus a per-body connect timeout so one stalled room cannot back
  up the pool. This is a new state machine, not a createFuji deletion: front-load it.
- Cold-body materialization latency (a latency property, NOT corruption). A body outside the
  bounded hot-set gets no relay push on a remote edit (fact 4: the relay does not
  enumerate/notify unjoined rooms), so its .md refreshes only on the next membership/join
  event: eventually consistent, never stale-on-read (every read is fresh). It cannot be
  dissolved without the room-listing API decision H refused. Document it; do not silently
  truncate coverage.
```

## References

```txt
packages/workspace/src/document/doc-guid.ts:27            the deterministic guid scheme
apps/fuji/src/lib/workspace/index.ts:64,137,414           table, hand-wired cache, guid fn
apps/honeycrisp/honeycrisp.ts:217                          honeycrisp guid fn
packages/filesystem/src/file-content-docs.ts:4             opensidian guid fn
apps/fuji/src/lib/workspace/project.ts                     daemon mount (root-only wiring today)
packages/workspace/src/document/attach-rich-text.ts:30,78  richText() codec read() (fact 5)
apps/opensidian/opensidian.ts:163,175                      opensidian body = attachTimeline (codec non-uniformity)
packages/workspace/src/document/attach-timeline/timeline.ts:146  timeline() codec read() (descriptor, decision C amend)
packages/workspace/src/shared/id.ts:52                     rowId = nanoid10, table-scoped not global (decision K)
packages/sync/src/room-route.ts:14                         room route (no enumeration exists)
packages/workspace/src/cache/disposable-cache.ts           browser body cache (generalized, not removed)
packages/workspace/src/document/on-local-update.ts         tx.local filter for the updatedAt bump (D)
packages/workspace/src/document/table.ts:309               Table.update (the generic bump target, D)
packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts:201  per-VALUE encryption (fact 6a)
packages/workspace/src/document/attach-encrypted-indexed-db.ts:92,134,238 per-UPDATE-BYTES encryption (fact 6b)
packages/workspace/src/document/internal/sync-supervisor.ts:233  raw updateV2 on the wire (fact 6)
packages/workspace/src/document/attach-yjs-log.ts          raw updateV2 in the daemon log (fact 6)
packages/workspace/src/document/define-table.ts            where column.body() is partitioned (A)
specs/20260530T160000-uniform-per-doc-providers.md          superseded mechanism (registry)
specs/20260530T120000-daemon-manifest-and-mount-materializers.md   reframed dependency
yjs/yjs (DeepWiki)                                          Q1-Q4 grounding (embedding, serialization, fragments, subdocs)
```
