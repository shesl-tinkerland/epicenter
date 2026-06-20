# Context: shared vocabulary

The words Epicenter uses for its own concepts, so humans and agents name the same
thing the same way. Keep entries to one or two lines. When a design pass coins or
sharpens a term, update it here in the same change. For the decisions behind these
shapes, see `docs/adr/`.

## Platform and topology

- **Workspace**: a Y.Doc that is at once a sync room and an access-policy atom. The
  unit apps compose; an app may compose several workspaces.
- **Room**: the server side of a workspace. One Cloudflare Durable Object with an
  embedded SQLite `updates` table.
- **Anchor**: the always-on node a workspace syncs through. Who runs the anchor is
  the privacy question: user-run gives topology privacy, Epicenter-run is trusted
  plaintext.
- **Trusted relay**: the server reads workspace plaintext. Zero-knowledge was
  evaluated and rejected; the encryption layer was removed (see `docs/adr/`).
- **Deployable vs library**: one library, `packages/server`, consumed by two
  deployables: `apps/api` (hosted personal cloud) and `apps/self-host` (the
  community shared-wiki reference, not Epicenter-operated).
- **`personal()` / `shared({ admit })`**: the `packages/server` seam that splits
  the two deployables. Billing is hosted-only and lives in `apps/api/worker/billing/`.

## Workspace API

- **`defineTable` / `defineKv`**: schema builders for a workspace's tables and
  key-value store.
- **`satisfiesWorkspace`**: the bundle-conformance helper (renamed from the older
  `defineWorkspaceBundle`).
- **`scan()`**: the single bulk table read. Returns three buckets, conforming,
  nonconforming, and newer-writer, plus point probes. The valid-only read family
  (`getAllValid`, `getAllInvalid`, `getAll`, `conformance`, `filter`) was deleted.
- **`_v`**: the per-row schema version tuple; conformance is judged against it.
- **Conformance**: whether a stored row matches the current schema. Nonconforming
  rows surface in `scan()`, never silently dropped.
- **Child doc**: a separate Y.Doc per row field (for example a transcript), reached
  through `ws.tables.X.docs.field.open(rowId)`. The workspace owns guid derivation.
- **Worker**: running behavior that observes workspace state and writes results
  back. Workers may be local (every node runs them) or agent-bound (one
  configured agent answers).
- **Agent**: the durable address a row or conversation binds to. An agent names
  who should answer; the worker is the runtime that answers as it.
- **Materializer**: a local, addressless worker that projects workspace data into
  another store (markdown, sqlite).
- **`attach*` vs `create*`**: `attach*` are side-effectful primitives that register
  listeners at call time; `create*` are pure construction.

## App composition

- **`create<App>`**: the isomorphic doc factory for an app.
- **`open<App>Browser` / `open<App>Extension` / tauri**: environment factories.
- **`#platform/*`**: the build-time platform DI seam for multi-platform (Tauri) apps.
- **`session`**: the singleton holding the signed-in workspace lifecycle.
- **deviceConfig vs workspace KV**: per-device settings (global shortcuts, machine
  collisions) versus synced settings (local shortcuts). The asymmetry is deliberate.
- **Vault**: an encrypted, shared workspace for secrets only. Blind relay;
  passphrase derives the key via Argon2.

## CLI and daemon

- **Epicenter root**: a directory whose `epicenter.config.ts` declares one mount.
  Discovery walks up to the nearest one. One root, one daemon.
- **Daemon**: the long-lived foreground process started by `epicenter daemon up`.
  It opens the root's mount and exposes it over a Unix socket as a callable peer.
- **Mesh peer**: a device whose daemon is online and reachable. `run --peer <id>`
  dispatches RPC to a remote peer; `peers` lists connected peers (presence).
- **Mandatory-daemon commands**: `run`, `list`, `peers`. They require a live local
  daemon (`getDaemon` returns `Required` otherwise); there is no cold-path
  fallback (see `docs/adr/`).
- **Library script**: a `bun ./script.ts` that calls a running daemon's actions
  through `connectDaemonActions` (a type-only proxy: it holds no Y.Doc and runs no
  workspace code) and composes/loops/dispatches RPC. Reads default to query
  actions; bulk reads drop to the read-only SQLite materializer. The automation
  surface; the CLI is a one-shot shell shortcut, not a place to build automation.
