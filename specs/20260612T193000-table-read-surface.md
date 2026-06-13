# Table read surface: one classified scan

**Date**: 2026-06-12
**Status**: Implemented
**Owner**: braden
**Builds on**: `specs/20260612T182447-workspace-schema-conformance.md` (the write guard and the first conformance pass, both already committed on this branch)
**Handoff**: `specs/20260612T193000-table-read-surface.handoff.md`

## One Sentence

A workspace table read resolves every stored entry into exactly one of four states (a conforming row, a nonconforming row this binary should understand but cannot parse, a row written by a newer binary, or an encrypted row this binary holds no key for), surfaced through a single classified `scan()` whose four buckets sum to a separate O(1) `storedCount()`, so no read can silently drop data and the count can never mysteriously disagree with what you can see.

## How to read this spec

```txt
Read first:
  One Sentence
  Why this exists (and why now)
  The four states (the whole design in one table)
  Target surface
  Implementation plan

Read if challenging the direction:
  The naming decision (scan)
  The unreadable bucket (the part that touches storage)
  Considered alternatives

Context you must not relitigate:
  The write guard is a real bug fix, not belt-and-suspenders. The killing
  mechanism is in the prior spec's Edge Cases and in project memory
  (epicenter_schema_evolution_direction.md). The epoch / authority /
  drain / single-schema alternatives stay refused; see the prior spec's
  Rejected Alternatives table.
```

## Why this exists (and why now)

The conformance work that already landed on this branch (write guard, `conformance()`, raw-on-every-parse-error, the Fuji repair queue) fixed the behavior: nonconforming rows are now visible and repairable, and a stale binary can no longer clobber a newer-stamped row. Two adversarial passes after it landed agreed the *behavior* is right and the *shape* is not.

The shape problem: the table grew a seventh bulk-read method (`conformance()`) beside `getAll`, `getAllValid`, `getAllInvalid`, `filter`, and `find`, all walking the same `entries() -> parseRow` boundary. A list-plus-banner view scans the table twice. The newer-writer distinction is a runtime comparison (`version > versions.length`) buried inside `conformance()` rather than a fact the type carries. And `count()` returns a number that disagrees with `getAllValid().length`, which was the original desync that started this whole investigation.

The first pass deferred the redesign because `@epicenter/workspace` looked like a published contract with ~26 `getAllValid()` callers. That constraint has been lifted: **this is greenfield, no published contract, no external users of the read surface.** Per `greenfield-clean-breaks`, compatibility is a product feature and nobody asked for it here, so the old read surface is removable. The only question left is what the cleanest shape is.

The deeper finding from the second pass is the reason this is worth a full spec rather than a rename: **the encrypted blind spot.** Most Epicenter apps, including Fuji (the app that already renders the repair queue), run encrypted tables. On an encrypted table, a row whose key version is missing from the keyring decrypts to nothing. Today that row is invisible everywhere: `entries()` skips it, `size` subtracts it, and only a bare `unreadableEntryCount` records that it exists at all. That is the same silent-disappearance this whole effort set out to kill, on a different axis (key material instead of schema). A redesign that models conformance honestly has to model that fourth state too, and doing so is what makes `storedCount()` reconcile instead of mysteriously exceeding everything you can see.

## The four states (the whole design in one table)

Every stored entry resolves to exactly one state. The states are mutually exclusive and collectively exhaustive over stored entries, which is the structural reason the read returns one value with four fields and the counts sum.

| State | Meaning | How a binary reaches it | Carries | Repairable? | Counts toward |
| --- | --- | --- | --- | --- | --- |
| conforming | parses and validates to the latest schema | normal | the row | n/a | `rows` |
| nonconforming | this binary should understand it but cannot: failed validation, failed migration, or a corrupt/unknown `_v` stamp at or below the latest known version | schema edited in place; corrupt data | raw stored value (with `_v`) | yes, from the raw value | `nonconforming` |
| newerWriter | `_v` is a number strictly above this binary's latest known version | a newer build wrote it and synced | id, version, latestVersion, raw value | no (needs an app update) | `newerWriter` |
| unreadable | encrypted blob this binary holds no key for | key rotation, missing key version, corrupt ciphertext | id, reason (no row exists to parse) | no (needs the key) | `unreadable` |

The two diagnostic-but-not-repairable states (`newerWriter`, `unreadable`) share a property the write side cares about: **you must not clobber what you cannot read.** Both refuse whole-row writes for the same reason the newer-writer guard already refuses, so the guard extends to cover `unreadable` rows once they are modeled.

`nonconforming` and `newerWriter` were the same `UnknownVersion` error variant before, separated by a buried comparison. They are genuinely different failure modes ("the data is broken" versus "this binary is stale"), so they become different variants, and the classification stops being a runtime branch a caller has to re-derive.

## The naming decision (scan)

You asked twice whether the method should be called `scan()`. Here is the reasoning, including the runners-up and why they lose.

The method walks every stored entry, classifies each, and returns a materialized snapshot of the four buckets. Two properties should be legible from the name: it is a full O(n) traversal (unlike the O(1) point reads `get`/`has`), and you get back a grouped result, not a cursor.

- **`scan()`** (recommended). In datastore vocabulary a table scan is "read every row without an index," which is exactly the cost profile. It pairs against `get`/`has` so the read surface reads as two cost tiers: point reads are cheap, `scan()` is the expensive full read. The one weak spot is that a classic scan is often a stream and this returns a materialized record, but that is a minor connotation mismatch.
- **`snapshot()`** (rejected, collision). Accurate for "materialized point-in-time view," but Yjs already owns `snapshot` as a history-marker concept (`Y.snapshot()`), and this codebase lives in Yjs. Reusing the word in the same mental space is a trap.
- **`read()` / `readAll()`** (rejected, says too little). "Read" is the natural verb for the operation but signals nothing about cost or classification, and `read()` singular reads like a one-item fetch. `readAll()` is just `getAll` with a coat of paint and still hides that you get buckets.
- **`audit()` / `inspect()`** (rejected, wrong emphasis). Both over-rotate on the diagnostic buckets when the conforming rows are the primary payload for almost every caller. A name that sounds like a compliance check buries the 95 percent use ("give me my rows").

Recommendation: `scan()`. If the team finds it too datastore-jargony for a local-first API, `read()` is the acceptable runner-up; do not use `snapshot()`.

A note on the buckets' own names: `rows`, `nonconforming`, `newerWriter`, `unreadable`. `nonconforming` carries the most jargon; `broken` is the plainer alternative and is honest (the other three states are not "broken"). This spec keeps `nonconforming` for continuity with Matter's existing conformance vocabulary (`apps/matter/src/lib/core/conformance.ts`), but `broken` is a legitimate swap if plainness wins. UI copy stays plain regardless ("Needs attention", not "Nonconforming").

## Target surface

Signatures first; the per-decision reasoning follows. File locations are deliberately omitted; the behavioral home is the table builder, the type home is its error module, and the storage change is in the shared kv contract and its encrypted implementation.

```ts
// The three "should-parse-but-cannot" causes. Every variant carries the raw
// stored value (including _v) so a repair flow can rebuild from it.
type TableParseError =
  | { name: 'UnknownVersion';   id: string; version: unknown; row: unknown }
  | { name: 'ValidationFailed'; id: string; errors: readonly {path: string; message: string}[]; row: unknown }
  | { name: 'MigrationFailed';  id: string; cause: unknown; row: unknown };

// A row a newer binary owns. Not a data-integrity failure; a staleness signal.
type TableNewerWriterError = {
  name: 'NewerWriter'; id: string; version: number; latestVersion: number; row: unknown;
};

// An encrypted entry with no usable key. No row exists to parse.
type TableUnreadableError = { name: 'UnreadableRow'; id: string; reason: string };

// The union get() can fail with: every reason a single read cannot return a row.
type TableReadError = TableParseError | TableNewerWriterError | TableUnreadableError;

// The classified snapshot. The four buckets partition stored entries; their
// lengths sum to storedCount().
type TableScan<TRow> = {
  rows: TRow[];
  nonconforming: TableParseError[];
  newerWriter: TableNewerWriterError[];
  unreadable: TableUnreadableError[];
};

type ReadonlyTable<TRow> = {
  name: string;
  definition: TableDefinition;
  schema: TObject;

  get(id: string): Result<TRow | null, TableReadError>;   // point read; Ok(null) = absent
  scan(): TableScan<TRow>;                                  // the one O(n) classified read
  findValid(predicate: (row: TRow) => boolean): TRow | undefined; // short-circuit, conforming only

  observe(cb: (changedIds: ReadonlySet<string>, origin?: unknown) => void): () => void;

  storedCount(): number;   // O(1) raw entry count = sum of the four scan buckets
  has(id: string): boolean; // O(1) existence of a stored entry (any of the four states)
};

type Table<TRow> = ReadonlyTable<TRow> & {
  set(row: TRow): Result<void, TableWriteError>;            // refuses newerWriter AND unreadable
  bulkSet(rows: TRow[], opts?): Promise<{ refused: TableWriteError[] }>;
  update(id: string, partial): Result<TRow | null, TableReadError>;
  delete(id: string): void;                                // unguarded: intent is shape/key independent
  bulkDelete(ids: string[], opts?): Promise<void>;
  clear(): { refused: TableWriteError[] };                 // skips and reports refusable rows
};

type TableWriteError =
  | { name: 'NewerWriterRefusal'; id: string; storedVersion: number; latestVersion: number }
  | { name: 'UnreadableRefusal';  id: string; reason: string };
```

### Delete

`getAll`, `getAllValid`, `getAllInvalid`, `conformance`, `filter`, and the old `count`. Reasoning per deletion:

- `getAllValid()` is the deletion that earns the redesign. A bulk read that returns only rows *is* the silent-drop footgun: it lets the default call path hide the other three states. Replacing it with `scan().rows` keeps the rows one property access away while putting the dropped buckets in the same return value, at the same call site, where a caller can log them, surface them, or ignore them deliberately rather than by default. The honest caveat: a mechanical `getAllValid() -> scan().rows` rewrite does not by itself make callers handle the buckets; it relocates the ignore. The win is that the buckets are now present to be acted on, and the specific callers that should act (a materializer logging rows it could not project) can. We accept that most callers will read `.rows` and move on, because that is a deliberate choice made with the data in hand, not a hidden default.
- `getAllInvalid()` and `conformance()` are subsumed: `scan().nonconforming` plus `scan().newerWriter` is exactly what they returned, now classified and each carrying the raw row.
- `getAll()` returned `Result[]` and pushed classification onto every caller; `scan()` owns the classification because the table owns `_v`, the version set, and the key material.
- `filter(predicate)` walks the whole table with no short-circuit, so it has no cost advantage over `scan().rows.filter(predicate)`; it is pure sugar and goes.
- `count()` returned `entries().size` and actively misled UIs that put it next to a filtered list. `storedCount()` keeps the O(1) cost but names what it counts.

### Keep

- `get(id)` is a real O(1) point read with its own failure channel; it returns `Ok(null)` for absent (not an error) and `Err(TableReadError)` for the three non-row states.
- `findValid(predicate)` survives the cut that `filter` does not, precisely because it short-circuits at the first match. On a large table, "find the first conforming row matching p" without building all four buckets is a genuine cost difference. The `Valid` in the name is honest: it can only match rows it can parse.
- `has(id)` and `storedCount()` are O(1) raw probes over stored entries, a different cost class and a different truth source than the parse walk. They stay separate from `scan()` for exactly that reason: bundling an O(1) raw count into an O(n) parse result would imply they reconcile by construction, when in fact reconciliation is a property worth asserting (see below).

## The unreadable bucket (the part that touches storage)

This is the heaviest and most reasoning-dense change, so it gets its own section.

Today's encrypted store hides undecryptable rows three ways: `entries()` yields only decryptable rows, `get()`/`has()` report them absent, and `size` subtracts them (`inner.map.size - unreadableEntryCount`). The result is that an undecryptable row counts toward nothing the caller can see, and `scan()` over the current `entries()` could never populate an `unreadable` bucket because the rows never reach it.

To model `unreadable` honestly, two things change in the storage contract:

1. The store must be able to enumerate undecryptable entries by id, not just count them. The shared `ObservableKvStore` contract grows a way to surface "entries that exist but did not decrypt" (id plus a reason such as `keyVersion 3 not in keyring`). For plaintext stores this is always empty. For the encrypted wrapper it is the set the current `unreadableEntryCount` already walks, now yielding ids.
2. `storedCount()` becomes the raw entry count after LWW conflict resolution, *including* undecryptable entries. Today encrypted `size` excludes them, which is precisely why the count cannot reconcile. The reconciliation we want to be able to assert:

```ts
storedCount() === scan.rows.length
              + scan.nonconforming.length
              + scan.newerWriter.length
              + scan.unreadable.length
```

For plaintext tables `unreadable.length` is always 0 and the identity still holds. The point of the identity is not that callers compute it; it is that the model has no gap. A row cannot exist in storage and be invisible to every read. That gap is the encrypted twin of the schema-edit silent drop, and closing it is the reason this is a four-bucket design and not three.

A consequence worth stating: the write guard tightens. Today `set()` over an undecryptable row sees `get()` return undefined, treats the slot as empty, and overwrites, destroying a row it could not read. Once the store can tell "absent" from "present but unreadable," `set()` refuses the unreadable case (`UnreadableRefusal`) the same way it refuses `newerWriter`. `delete(id)` stays unguarded, because deleting a row you cannot read is a legitimate, shape-independent and key-independent intent.

## The write side

The guard from the prior spec is correct and stays; greenfield only makes it more complete and its channel richer.

- `set(row)` reads the stored entry and refuses if it is `newerWriter` (stored `_v` above latest) or `unreadable` (present but no key). Returns `Result<void, TableWriteError>`.
- `bulkSet` guards per chunk at write time (an up-front filter goes stale across the awaited chunk boundary) and returns `{ refused: TableWriteError[] }`, carrying the version or reason per refusal rather than just ids, so an import banner can say what it skipped and why.
- `clear()` skips refusable rows (`newerWriter` and `unreadable`) and reports them; `delete`/`bulkDelete` stay unguarded.
- `update(id, partial)` routes through `get()`, so it inherits the refusals for free and fails with `TableReadError`. The asymmetry with `set()`'s `TableWriteError` is intentional: `update` must read before merging, so its failure is read-shaped; `set` decides without a parse, so its failure is write-shaped. Both classify the same underlying states.

## The Svelte side

Greenfield, the reactive helper should not reproduce the footgun the library just removed. A `fromTable()` that returns only a `SvelteMap` of valid rows hides the same three states at the UI layer, and pairing it with a separate optional `fromTableConformance()` is the same redundant double-subscription the library is collapsing.

One reactive binding exposes both, from one `observe()` subscription:

```ts
const entries = fromTable(table);
entries.rows           // reactive map/array of conforming rows, updated granularly per changed id
entries.nonconforming  // bucket, recomputed on a debounce
entries.newerWriter
entries.unreadable
```

The cost nuance that must be preserved: today's `fromTable` updates rows granularly (only changed ids re-render via per-row `get()`), which is the right behavior for a hot list. A naive "re-`scan()` on every change" loses that. So the binding keeps granular per-row updates for `.rows` and recomputes the three issue buckets via a debounced `scan()`. Buckets change rarely (a schema edit, a sync from a newer build, a key change), so a debounced full re-scan is the correct cost trade; rows stay granular because they change on every keystroke.

`fromTableConformance` is deleted; its single consumer (Fuji) reads the merged binding. The Fuji repair queue reads `entries.nonconforming` for repairable rows, `entries.newerWriter` for the "update to edit" banner, and gains an `entries.unreadable` surface for "encrypted with a key this device does not have," which is a real state for a multi-device encrypted app and was previously invisible.

## Considered alternatives

| Option | Why not |
| --- | --- |
| `getAll(): Result<Row, Error>[]` as the sole primitive, plus a pure `classify()` helper | Pushes the table's own invariant (which version is "newer", whether a row is repairable) onto every caller, who would write `getAll().flatMap(r => r.error ? [] : [r.data])` and re-decide it each time. The table owns `_v` and the key material, so the table should own the classification. |
| Lazy iterator `*scanEntries()` yielding per-entry status | Saves bucket allocation and preserves ordering/streaming, but most callers want grouped rows plus issue queues, and a lazy iterator makes error handling easy to skip and Svelte state uglier. Worth adding later as a lower-level primitive *if* a streaming caller appears (a 100k-row export). Trigger: a caller that must process entries in storage order or without materializing all of them. |
| Per-row status union returned as a flat `EntryState[]` | Cleaner for ordering, but forces every caller to regroup into the four buckets they actually want. The fat record does the grouping once. |
| Keep `getAllValid()` as ergonomic sugar over `scan()` | Reintroduces the default-path that silently drops three states. The whole point is that the only bulk read hands you the buckets too. |
| Bundle `storedCount` into `scan()`'s return | Mixes an O(1) raw probe with an O(n) parse walk and two different truth sources, and implies they reconcile by construction. Keeping `storedCount()` separate makes the sum an assertable property rather than a hidden assumption, and lets callers take the cheap count without paying for a scan. |
| Name the method `snapshot()` | Collides with `Y.snapshot()` in a Yjs codebase. |

## Asymmetric win

Product sentence that must survive: a table read resolves every stored entry into one visible state, no read silently drops data, and a stale or keyless binary cannot clobber a row it cannot read.

Refusal that collapses the surface: delete the entire valid-only bulk-read family (`getAll`, `getAllValid`, `getAllInvalid`, `conformance`, `filter`) and the misleading `count`, in exchange for one `scan()` plus a renamed `storedCount()`. Seven-ish bulk-read entry points become two (`scan`, `findValid`) plus the point reads. The classification leaves runtime call sites and enters the type system (`NewerWriter` and `UnreadableRow` as named variants), so it is computed once, where the knowledge lives, and consumed by exhaustive switch everywhere else. User loss: a few characters at call sites (`scan().rows` instead of `getAllValid()`). What disappears: five methods, one duplicate Svelte subscription, the `count`/`getAllValid` desync, the buried `version > versions.length` comparison, the recurring "did this read silently skip errors?" question, and the encrypted silent-drop blind spot.

## Implementation plan

Each wave is one standalone commit (see `standalone-commits`), reasoning carried in the claim. Build on the committed conformance branch; this reworks the read surface forward rather than reverting it. Test-first for waves 1, 2, and 4.

### Wave 1: split the error taxonomy

Claim: `feat(workspace): make NewerWriter a first-class table read error`.

Move the `version > versions.length` decision out of `conformance()` and into `parseRow`, where the version set is already in scope, and emit a distinct `NewerWriter` error there. `UnknownVersion` shrinks to genuinely corrupt or non-numeric stamps. `get()` now reports newer-writer rows as `NewerWriter` instead of `UnknownVersion`. No public read method is added or removed yet; `conformance()` (still present) becomes a trivial group-by-name. This is the cheap, high-value core: the classification becomes a type fact, available to every consumer, and the only exhaustive consumer in the codebase today is the Fuji page, which gains one case.

### Wave 2: model the unreadable bucket and reconcile storedCount

Claim: `feat(workspace): surface undecryptable rows and make stored count reconcile`.

Teach the shared kv contract to enumerate present-but-unreadable entries (id plus reason); plaintext returns empty, the encrypted wrapper yields the set it already counts. Redefine the raw count to include them so the four-bucket sum holds. Test-first with an encrypted fixture holding one blob whose key version is absent from the keyring: assert it appears as `unreadable`, that `storedCount` includes it, and that the sum identity holds. This is the heaviest wave because it touches the storage boundary, and it is the one that closes the encrypted silent-drop.

### Wave 3: collapse the bulk reads into scan()

Claim: `feat(workspace): replace the valid-only read family with one classified scan`.

Add `scan()` returning the four buckets; delete `getAll`, `getAllValid`, `getAllInvalid`, `conformance`, `filter`; rename `find` to `findValid` and `count` to `storedCount`. Migrate every in-repo caller (materializers, daemon projections, the app query handlers, the Svelte helper) to `scan().rows` or `findValid`. Greenfield, this is one clean sweep rather than a deprecate-then-remove, because there is no external contract to keep alive. If the diff is too large to review in one commit, split the migration per consumer package, but keep the deletion in the same commit as the last migrated caller so the tree never carries a dead method. The materializer migration should take the opportunity to log `scan().nonconforming` rather than silently project only `.rows`, which is the concrete payoff of having the buckets in hand.

### Wave 4: extend the write guard to unreadable rows

Claim: `fix(workspace): refuse whole-row writes over rows this binary cannot read`.

`set()`/`bulkSet()`/`clear()` refuse `unreadable` rows alongside `newerWriter`, using the present-but-unreadable probe from wave 2. Richer refusal payload (`TableWriteError` carries version or reason). Test-first: an encrypted table with an undecryptable row refuses `set()` over it and leaves it intact, the same shape as the existing newer-writer clobber test.

### Wave 5: one reactive binding

Claim: `feat(svelte): expose rows and scan health from a single table binding`.

Merge `fromTable` and `fromTableConformance` into one binding: granular per-row `.rows`, debounced `.nonconforming` / `.newerWriter` / `.unreadable`, one subscription. Delete `fromTableConformance`. Update the Fuji repair queue to read the merged binding and to render the `unreadable` state as its own surface ("encrypted with a key this device does not have").

### Wave 6: record the contract

Claim: `docs(workspace): document the classified read surface and the four states`.

`packages/workspace/src/document/README.md` design-decisions section; an ADR for "one classified scan, no valid-only default read" and one for "stored entries reconcile to four visible states (the unreadable bucket)"; update the `workspace-api` skill to teach `scan()` and retire the `getAllValid`/`getAllInvalid` vocabulary.

## Open questions

1. **Bucket name: `nonconforming` or `broken`.** `nonconforming` matches Matter; `broken` is plainer and still distinct from the other three states. Recommendation: keep `nonconforming` for vocabulary continuity, but this is a free swap if plainness wins. UI copy stays plain either way.
2. **`has(id)` semantics over unreadable rows.** `has` should mean "a stored entry exists," which includes unreadable and newer-writer rows. Confirm no caller expects `has` to mean "a row I can read." Recommendation: `has` = raw existence, documented; add `getValid` only if a caller genuinely needs "readable and conforming."
3. **`scan()` vs `read()` final name.** Recommendation `scan()` for the cost signal; `read()` is the acceptable runner-up. Decide before wave 3 since it renames every caller.
4. **Should `scan()` accept a predicate for the rows bucket?** A `scan({ where })` could fuse the common "scan then filter rows." Recommendation: no; keep `scan()` argumentless and let callers `.rows.filter()`. Revisit only if profiling on a large table shows the intermediate array matters.

## Success criteria

- One bulk read (`scan()`) returns all four buckets; `getAll`/`getAllValid`/`getAllInvalid`/`conformance`/`filter` no longer exist; no caller renders a valid-count next to a different total.
- On an encrypted table with an undecryptable row, the row appears in `scan().unreadable`, is counted by `storedCount()`, the four buckets sum to `storedCount()`, and `set()` over it refuses while `delete()` removes it.
- A newer-stamped row appears in `scan().newerWriter`, `get()`/`update()`/`set()` against it refuse, and its columns survive an older binary's write attempt (the existing clobber test, now on the new shape).
- The Fuji binding exposes rows plus the three issue buckets from one subscription; `fromTableConformance` is gone; editing the schema in place produces a visible nonconforming count that the repair queue can drive back to zero.
- `bun run typecheck` and the workspace tests pass after every wave; each wave is a standalone commit.

## References

- `specs/20260612T182447-workspace-schema-conformance.md`: the prior pass; its write-guard mechanism and Rejected Alternatives table remain in force.
- `packages/workspace/src/document/table.ts`: parseRow and the read/write surface; where waves 1, 3, 4 land.
- `packages/workspace/src/document/y-keyvalue/observable-kv-store.ts`: the shared store contract that grows the unreadable-entry probe in wave 2.
- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts`: where `unreadableEntryCount` becomes an id-yielding enumeration.
- `apps/matter/src/lib/core/conformance.ts`: prior art for classification-not-gating and the `nonconforming` vocabulary.
- `packages/svelte-utils/src/from-table.svelte.ts`: the binding merged in wave 5.

## Review

**Completed**: 2026-06-12
**Branch**: greenfield-table-scan (on `lechuguilla-talus`)

### What Landed

All six waves shipped as standalone commits, each green on `bun test`
(workspace) plus `bun run typecheck` (all packages). The read surface is now one
classified `scan()` over four buckets (`rows`, `nonconforming`, `newerWriter`,
`unreadable`) whose lengths sum to `storedCount()`; the valid-only family
(`getAll`, `getAllValid`, `getAllInvalid`, `conformance`, `filter`) and the
misleading `count` are gone, with every in-repo caller migrated. The encrypted
store enumerates undecryptable entries and counts them, the write guard refuses
unreadable rows alongside newer-writer rows, and the Fuji binding plus repair
queue surface all three issue states from one subscription. The decisions are
recorded in `docs/adr/0001-classified-scan-read-surface.md`,
`docs/adr/0002-four-visible-read-states.md`, the workspace document README, and
the `workspace-api` skill.

### Deviations and Discoveries

- **Confirmed naming up front.** `scan()` (over `read()`) and `nonconforming`
  (over `broken`), per the Open Questions, before wave 3 renamed callers.
- **Wave 5 keeps the map as the primary surface.** The spec example wrote
  `entries.rows`, which would have changed roughly sixteen `fromTable` consumers
  across eight apps that only want reactive rows. Instead the returned value
  stays the rows `SvelteMap` and the three issue buckets are attached as
  debounced properties. Same single subscription, zero breakage to the row-only
  consumers; only the conformance view reads the buckets. Recorded as the
  asymmetric win it is.
- **Wave 4 added an O(1) point probe.** Wave 2 delivered the enumeration the
  spec scoped (`unreadableEntries()`); the write guard then needed a per-key
  check, so the contract grew `unreadableReason(key)` (O(1), the per-key form of
  the enumeration). `get()`/`update()` use it too, so they report `UnreadableRow`
  instead of a silent `Ok(null)`. `parseRow` keeps the narrower
  parse-or-newer-writer union so `scan()` switches over it exhaustively, while
  `TableReadError` (the point-read channel) carries all three non-row states.

### Follow-up Work

- A lazy `*scanEntries()` iterator stays deferred until a streaming caller
  appears (a large export that must process entries in storage order without
  materializing all four buckets). Trigger recorded in Considered Alternatives.
- The narrative articles under `docs/articles/` still show `getAllValid()` in
  point-in-time code snippets. Left as published history, the same as the dated
  specs under `specs/`; the canonical teaching surfaces (package README,
  document README, `workspace-api` skill) were updated.
