# local-books

Headless CLI that mirrors a QuickBooks Online company into a local SQLite database and keeps it current with incremental Change Data Capture (CDC). This is a faithful, re-pullable mirror, not a ledger: QuickBooks owns authoritative history, CDC drives upserts into current state.

Design authority: `specs/20260621T100000-local-books-cli-sync-engine.md` (top-level specs dir). Read it before changing the sync model.

## Shape

- Runtime: Bun. `bun:sqlite` for storage, built-in `fetch` for the QB API, `oauth4webapi` for the OAuth2 grants (the same client `@epicenter/auth` uses; we own only the localhost callback and the QuickBooks-specific `realmId`). Runtime deps are pure-TS and dependency-free so `bun build --compile` yields one binary: `wellcrafted` (Result/error idioms), `typebox` (validating untrusted token grants and `config.json`), and `oauth4webapi`. All three are cataloged and used elsewhere in the monorepo.
- One SQLite file per company: `<data-dir>/<realmId>/books.db`. Tokens live in the OS keyring (never the data dir). Sync state lives in the db (`_sync_state`), not a sidecar, so ingest-and-advance is one transaction.
- One table per QB entity (`invoices`, `customers`, ...): `id`, `raw` (verbatim QB JSON), `updated_at`, `synced_at`, `deleted`, plus a few extracted scalar columns for indexing/joins. New QB fields land in `raw` with no migration.

## Grounded QB constants (verified against developer.intuit.com, 2026-06-21)

- CDC lookback window: 30 days. Past that, CDC cannot cover the gap, so the engine forces a FULL pull. `CDC_SAFE_WINDOW_DAYS` keeps a margin under 30.
- CDC max objects per response: 1000 per entity.
- Rate limits: 500 req/min per realmId, 10 concurrent, 40 batch/min. 429 `ThrottleExceeded` (errorCode 003001) → back off ~60s.
- Deletes: CDC returns deleted entities carrying `status: "Deleted"` + `Id` + `MetaData.LastUpdatedTime`. We soft-delete (`deleted = 1`), never hard-delete: a CDC delete means QB no longer has the object, so the local blob is the only surviving copy.

## CLI

```
local-books auth                              # one-time OAuth2 (localhost callback), tokens -> keyring
local-books sync [--full] [--entity <name>...]
local-books status
```

Mode is chosen from stored state: `--full` / no cursor / cursor older than the CDC window / full-pull staleness backstop → FULL; otherwise INCREMENTAL.

## Config (env or `<data-dir>/config.json`)

- `QB_CLIENT_ID` / `QB_CLIENT_SECRET` — your Intuit app keys (required for `auth`). This is what Infisical injects at `/apps/local-books`, so the usual invocation is `infisical run --path=/apps/local-books -- bun run src/bin.ts auth`.
- `LOCAL_BOOKS_QB_ENV` — `sandbox` (default) or `production`.
- `LOCAL_BOOKS_DIR` / `--data-dir` — data directory override.
- `LOCAL_BOOKS_KEYRING_FILE` — opt-in plaintext file token store (CI / headless boxes without a keyring daemon, and the test harness). Default is the OS keyring.
- Base-URL overrides (`LOCAL_BOOKS_QB_API_BASE`, `_TOKEN_URL`, `_AUTHORIZE_URL`) point the client at a mock server for tests.

## Agent surface (ADR-0047)

`books.ts` + `mount.ts` wrap the mirror as an Epicenter **data daemon**: it holds the SQLite and serves it as dispatched actions, but never runs inference. A client agent loop (`@epicenter/workspace/agent`) opens the same synced room and dispatches the tools; the financial data leaves the machine only as a tool result.

- `src/agent/books-query.ts` — `books_sql_query`, a read-only SQL query (`query`, auto-approved). Enforced read-only by a `new Database(path, { readonly: true })` connection, not a string check; results are row-capped.
- `src/agent/books-actions.ts` — `createBooksAgentActions({ dbPath })`, the served registry. The write tools (`mark_reviewed`, `add_note`) need an overlay table (parked in the spec) and land here next, gated by the synchronous approval pause.

The CLI binary (`bin.ts` -> `cli.ts`) does not import this layer, so `bun build --compile` of the CLI stays lean.

## Testing

`bun test` boots a mock QB server (`test/mock-qb-server.ts`) and drives the real command paths against it (seeded file keyring), so full pull, incremental CDC, cursor advance, and soft-delete are proven end-to-end without a live sandbox. The interactive browser hop of `auth` is the only piece a live sandbox is needed for. The agent surface (`src/agent/`) is tested through the real dispatch catalog against a seeded mirror.
