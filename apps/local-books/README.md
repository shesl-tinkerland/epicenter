# local-books

A headless CLI that mirrors a QuickBooks Online company into a local SQLite database and keeps it current with incremental Change Data Capture (CDC). The mirror is a faithful, re-pullable cache: QuickBooks owns authoritative history, CDC drives upserts into current state.

## Commands

```
local-books auth                              # one-time OAuth2 (localhost callback), tokens -> OS keyring
local-books sync [--full] [--entity <name>]   # refresh the mirror; mode is chosen from stored state
local-books status                            # token state + per-entity cursor, row counts, last full pull
```

`sync` chooses FULL vs INCREMENTAL per entity from stored `_sync_state`: a first run, a cursor older than the CDC 30-day window, or a stale full-pull backstop forces FULL; otherwise it runs CDC since the last cursor. `--full` forces FULL.

## Setup

You need an Intuit developer app (https://developer.intuit.com → your app → Keys & credentials) with `http://localhost:8765/callback` registered as a redirect URI. Intuit issues two key sets, and they are not interchangeable:

- **Development keys** connect sandbox companies only. Use them with `--env sandbox` (the default).
- **Production keys** connect your real company. Use them with `--env production`. Intuit only issues these once the app has passed their production go-live assessment.

Provide the keys as `QB_CLIENT_ID` / `QB_CLIENT_SECRET`:

```sh
export QB_CLIENT_ID=...
export QB_CLIENT_SECRET=...
```

In this monorepo the keys live in Infisical at `/apps/local-books`, split by Infisical environment: the `dev` environment holds the development keys, the `prod` environment holds the production keys. Pick the Infisical environment that matches the QuickBooks deployment you are targeting.

### Mirror a sandbox company

```sh
infisical run --path=/apps/local-books -- bun run src/bin.ts auth
infisical run --path=/apps/local-books -- bun run src/bin.ts sync --entity Invoice --full
infisical run --path=/apps/local-books -- bun run src/bin.ts status
```

### Mirror your real company

Two different `--env` flags are in play, and they are easy to confuse:

- `infisical run --env=prod` selects the Infisical environment, which decides which key set is injected.
- `bun run src/bin.ts ... --env production` selects the QuickBooks deployment, which decides which Intuit API the CLI calls.

Both must say production, on every command. `auth` captures the `realmId` from the OAuth callback, so you never pass `--realm`; you just log into the real company in the browser.

```sh
infisical run --env=prod --path=/apps/local-books -- bun run src/bin.ts auth --env production
infisical run --env=prod --path=/apps/local-books -- bun run src/bin.ts sync --env production --entity Invoice --full
infisical run --env=prod --path=/apps/local-books -- bun run src/bin.ts status --env production
```

Those three invocations are wrapped as `:remote` scripts so you do not have to assemble the double-`--env` dance by hand (extra flags pass through to the end):

```sh
bun run auth:remote
bun run sync:remote --entity Invoice --full
bun run status:remote
```

#### Production needs an HTTPS tunnel for the one-time `auth`

Intuit production rejects `http://localhost` redirect URIs (only Development accepts them), so the interactive `auth` hop needs a public HTTPS URL. This is only for `auth`: once tokens are in the keyring, every `sync` refreshes them and never touches the redirect URI again.

1. Start a tunnel to the local callback port (`cloudflared` needs no account):
   ```sh
   cloudflared tunnel --url http://localhost:8765
   ```
   Copy the `https://<name>.trycloudflare.com` URL it prints.
2. On the Intuit app's **Production** Redirect URIs, add exactly `https://<name>.trycloudflare.com/callback`.
3. Run `auth` with the tunnel as the public redirect, pointing the local listener back at 8765:
   ```sh
   LOCAL_BOOKS_QB_REDIRECT_URI=https://<name>.trycloudflare.com/callback \
   LOCAL_BOOKS_CALLBACK_PORT=8765 \
     bun run auth:remote
   ```
   `LOCAL_BOOKS_CALLBACK_PORT` decouples the local listener from the portless tunnel host. After tokens land in the keyring, stop the tunnel; `sync:remote` and `status:remote` need nothing further.

To avoid repeating `--env production` outside the scripts, set `LOCAL_BOOKS_QB_ENV=production` once, or write `{ "environment": "production" }` into `<data-dir>/config.json`.

## Where things live

```
<data-dir>/<realmId>/books.db   # entity tables + _sync_state + _meta
OS keyring (keyed by realmId)    # OAuth tokens, never the data dir
<data-dir>/config.json           # optional: entities, environment, schedule
```

`<data-dir>` defaults to the OS app-data path (`~/Library/Application Support/local-books` on macOS), overridable with `--data-dir` or `LOCAL_BOOKS_DIR`. `--env sandbox|production` (default `sandbox`) selects the QuickBooks API.

Tokens go in the OS keyring (macOS `security`, Linux `secret-tool`). On a headless box without a keyring daemon, or in CI, set `LOCAL_BOOKS_KEYRING_FILE=<path>` to use a plaintext file store instead.

## Build a single binary

```sh
bun run build:binary        # -> dist/local-books
```

## Keeping it fresh

Run a sync whenever you want current data:

```sh
local-books sync
```

Or keep it syncing in the background with `--interval`:

```sh
local-books sync --interval 30m
```

That runs a sync now and again every 30 minutes until you stop it with Ctrl-C. The first pass honors `--full`; every pass after that is incremental, so `--full --interval` means "one full pull, then keep up with CDC". In this monorepo:

```sh
infisical run --path=/apps/local-books -- bun run src/bin.ts sync --interval 30m
```

`sync` is stateless across runs (the cursor lives in the db), so it is safe to stop and restart anytime. To keep it running across logout or reboot, wrap that command in a launchd `KeepAlive` agent (macOS) or a systemd user service — you only need that once this graduates from an experiment.

## Develop

```sh
bun test            # boots a mock QuickBooks server and drives the real command paths
bun run typecheck
bun run test/demo-e2e.ts   # end-to-end demo against the mock (full pull -> incremental)
```
