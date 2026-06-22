# Local Books: QuickBooks to SQLite sync CLI

- Status: Draft
- Date: 2026-06-21
- Supersedes the data-layer intent of `specs/20260620T180000-local-books-agent-over-sql.md` (the agent-over-SQL daemon, the conversation doc, and the tool-approval seam are dropped; see Context). That spec should be retired once this one is in progress.

## Context

Local Books began as an "agent over SQL" product: a daemon that answered chat questions about your books by running SQL, streaming answers into a synced conversation doc. A design pass collapsed that scope twice.

1. The chat agent is off the shelf. A general local coding agent (Codex or Claude Code) running on the box already queries a local SQLite file with SQL, owns its own tool loop and approvals, and streams its work. You reach it from any device by remote control over a private Tailscale mesh, and the books never leave the box. That removes the need for a bespoke agent loop, a tool-approval seam, and a conversation doc. (Consequence elsewhere: this also removes Local Books as a second consumer of the AI doc-streaming core, so vocab is free to take its clean break.)
2. The data substrate is not off the shelf. Surveyed Node and Rust options: none keep a queryable mirror fresh via incremental CDC. `quickbooks-cli` (Rust) is a query tool with a TTL response cache and no CDC; `quick-oxibooks` is a blocking client. So the one thing worth building is the engine that pulls QuickBooks Online into a faithful local SQLite mirror and keeps it current.

This spec covers that engine only.

## Scope

In scope:
- A headless CLI, `local-books`, that authenticates to QuickBooks Online and maintains a local SQLite mirror.
- Full pull and incremental (CDC) refresh, with the engine choosing the mode from stored state.

Out of scope, deliberately:
- The chat agent and any AI inference (off the shelf).
- Syncing the books across devices, or any CRDT / Yjs. The mirror is box-local and re-pullable.
- Annotations or a user overlay (parked; later an additive table joined on the QB id).
- A GUI or Tauri shell. OAuth uses a localhost-callback flow that needs a browser, not a desktop app.

## Locked decisions

1. **Runtime: Bun.** QuickBooks ships an official OAuth2 library for Node (`intuit-oauth`); the API returns JSON, which matches the raw-blob storage; `bun:sqlite` is built in; `bun build --compile` yields a single binary for a headless box. Not Rust, not Tauri.
2. **Storage model: current-state mirror, not a ledger.** CDC drives upserts into current state; the change stream is the input, never the storage. QuickBooks owns the authoritative history.
3. **Faithful 1-1.** One table per QB entity type. Store the raw QB JSON per object plus a few extracted scalar columns for indexing and joins. New QB fields appear in the blob with no migration.
4. **Sync state lives inside the db, not a sidecar file** (see Architecture: atomicity).
5. **Minimal dependencies.** `intuit-oauth` for the token lifecycle, built-in `fetch` for data and `/cdc`, `bun:sqlite` for storage. Tokens go in the OS keyring, never in the data dir.

## Architecture

### File layout

```
<data-dir>/<realmId>/books.db      # entity tables + _sync_state + _meta
OS keyring (keyed by realmId)       # OAuth tokens
<data-dir>/config.json (optional)   # which entities, schedule; user-authored
```

`<data-dir>` defaults to an OS app-data path (macOS `~/Library/Application Support/local-books`, Linux `~/.local/share/local-books`), overridable by `--data-dir` / `LOCAL_BOOKS_DIR`. Scoping by `realmId` (the QB company id) keeps multiple companies from colliding.

### Entity tables (one per QB type, e.g. `invoices`)

```sql
CREATE TABLE invoices (
  id          TEXT PRIMARY KEY,            -- QB Id
  raw         TEXT NOT NULL,               -- full QB object JSON, verbatim
  updated_at  TEXT,                        -- extracted MetaData.LastUpdatedTime
  synced_at   TEXT NOT NULL,               -- when this row was last written locally
  deleted     INTEGER NOT NULL DEFAULT 0   -- soft-delete from a CDC delete event
  -- plus a few extracted scalar columns per entity for indexing/joins
  -- (e.g. invoices: doc_date, total_amt, customer_ref)
);
```

Soft-delete, not hard-delete: a CDC delete means QuickBooks no longer has the object either, so a local hard-delete would erase the only surviving copy. Keep the blob, flag it; the agent filters `WHERE deleted = 0`.

### Sync state, and why it lives in the db

```sql
CREATE TABLE _sync_state (
  entity            TEXT PRIMARY KEY,  -- 'Invoice', 'Customer', ...
  cdc_cursor        TEXT,              -- ISO timestamp to pass as changedSince next run
  last_full_pull_at TEXT,
  last_synced_at    TEXT
);
CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT);  -- realmId, schema_version
```

The cursor must advance in the same transaction that writes the rows it accounts for. A sidecar `.json` cannot join a SQLite transaction, so a crash between "rows written" and "cursor written" either re-pulls (harmless, upserts are idempotent) or, worse, skips data (cursor advanced, rows lost). A `_sync_state` row written inside the upsert transaction makes ingest-and-advance atomic and crash-safe, and keeps the db a single self-contained, copyable artifact.

This is the answer to "colocate data and updated_at": yes, in the same transactional store, not a separate file. User config has no atomicity need, so it may stay a json or flags; secrets go in the keyring.

### Sync algorithm

```
for each configured entity:
  state = _sync_state[entity]
  mode =
    --full flag                            -> FULL
    no cursor (first run)                  -> FULL
    now - cursor > CDC_WINDOW (lossy gap)  -> FULL   (CDC cannot cover the gap)
    last_full_pull_at older than N days    -> FULL   (correctness backstop)
    else                                   -> INCREMENTAL

  FULL:        paginate the QB query API, UPSERT all,
               set cdc_cursor = now, set last_full_pull_at = now
  INCREMENTAL: GET /cdc?entities=<entity>&changedSince=<cdc_cursor>,
               UPSERT changed, mark deletes, set cdc_cursor = now

  all writes for an entity + its _sync_state row commit in ONE transaction
```

This is "cache when we last pulled so a re-run knows how": the stored cursor selects the mode automatically; `--full` overrides; the CDC-window and staleness checks force a full resync when incremental cannot be trusted.

### CLI surface

```
local-books auth                              # one-time OAuth2 (localhost callback), tokens -> keyring
local-books sync [--full] [--entity <name>...]
local-books status                            # per-entity cursor, last full pull, row counts, token expiry
```

Schedule `sync` with cron / launchd / systemd on the box.

## Spike-verify items (do not trust assumptions; ground against QB docs)

- QuickBooks rate limits and throttling; add backoff and a concurrency cap to the full pull.
- The actual CDC lookback window (commonly cited near 30 days) and per-call entity/result caps; these set `CDC_WINDOW` and the force-resync threshold.
- `intuit-oauth` runs clean on Bun; fallback is a hand-rolled OAuth2 authorization-code + PKCE flow.
- The QB entity list to mirror, and which scalar columns are worth extracting per entity.
- Delete semantics in `/cdc` (confirm deletes are reported, and how).

## Slices (each ends green and demoable)

1. `auth`: OAuth2 against a QB sandbox company, tokens in keyring, `status` shows token state.
2. Full pull of one entity (`Invoice`) into `invoices` with raw blob + extracted columns; `_sync_state` and `_meta` created.
3. Incremental: `/cdc` since cursor, upsert + soft-delete, atomic cursor advance; mode auto-selection and `--full`.
4. All configured entities; backoff and rate-limit handling; force-resync backstops.
5. `bun build --compile` single binary plus an example launchd/systemd unit.
