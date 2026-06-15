# Epicenter API (Hosted Personal Cloud)

Epicenter Cloud Worker. Handles authentication, real-time sync, AI inference, and billing for the hosted personal cloud product. Composes `@epicenter/server` with the `personal()` ownership rule.

This folder is a single Cloudflare Worker deployment: `worker/` (Hono code) and `ui/` (SvelteKit dashboard SPA) ship together. Self-hosted shared-wiki deployments live in the sibling `apps/self-host`; they compose the same `@epicenter/server` library with `shared({ admit })` and no billing surface.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo. AGPL-3.0 licensed. If you host a modified version, you share your changes. See `apps/self-host` for the self-hosted reference and the encryption/trust model below.

Runs on Cloudflare Workers with Durable Objects. Cloud sync opens documents through `/api/owners/:ownerId/rooms/:room` (the same path in both personal and shared mode): a cloud doc is owned by the authenticated `ownerId` and addressed by its `ydoc.guid`, and the route resolves the DO name `owners/${ownerId}/rooms/${room}` from the auth token. In personal mode `ownerId === user.id`; in shared mode `ownerId === 'shared'`. Browser apps and the workspace daemon both use this route. The Hono route's auth middleware authorizes the caller before it builds the internal room name.

## Why a hub exists

Local-first doesn't mean no server. It means your data lives on your machine and you aren't dependent on a cloud service to function. But some operations genuinely need a single authority: user identity, API key storage, AI proxying. Trying to make every device a peer for these operations led to three failed attempts at distributed key management before we split into hub (central authority) and local (device-side execution).

The hub handles auth, sync relay, and AI. Local servers handle filesystem access, offline editing, and low-latency operations. Neither tries to do the other's job. See [Why Epicenter Split Into Hub and Local Servers](/docs/articles/why-epicenter-split-into-hub-and-local-servers.md) for the full story.

## Stack and priorities

Hono handles HTTP routing. We originally wanted Elysia: it's faster, the API is more ergonomic, and it runs natively on Bun. But Elysia depends on Bun-specific APIs that don't exist in the Cloudflare Workers runtime, and Workers compatibility was non-negotiable. Hono runs on Cloudflare Workers, Node.js, Deno, Bun, and AWS Lambda. When we build self-hosting adapters, the route layer comes along for free.

Cloudflare Durable Objects are the current deployment target. Three things make them a natural fit for Yjs sync rooms:

- **Single-threaded per object.** Each Room runs in its own isolate. No mutex, no race conditions on CRDT state. The runtime guarantees it.
- **Built-in SQLite.** The update log lives inside the Durable Object's storage. No external database for sync state, no connection pooling, no cold-start latency from network hops.
- **WebSocket Hibernation.** Idle connections don't consume compute. A user can leave a tab open for hours and the DO sleeps until the next message arrives. Costs stay proportional to actual sync traffic, not connection count.

We're focused on Durable Objects to keep the maintenance surface small and iterate fast. The Cloudflare-specific sync code lives in `room.ts`. Everything else, routes, auth, AI, and validation, is runtime-portable Hono code.

We want self-hosting adapters. The plan is to stabilize the API surface on Durable Objects first, then extract the sync room logic into a runtime-agnostic layer backed by Node.js WebSockets + SQLite. If you want to deploy today, fork the repo and use the existing `wrangler.jsonc`. Everything you need is in there.

Better Auth handles identity: email/password and Google OAuth for sign-in, plus an OAuth provider plugin that turns the hub into a standards-compliant OAuth server. Desktop and mobile clients authenticate via OAuth/PKCE flows, get a token, and use it for all subsequent API calls and WebSocket connections.

## Encryption and trust model

Workspace data is encrypted at the CRDT level using XChaCha20-Poly1305 via @noble/ciphers (audited by Cure53). The encryption wraps YKeyValueLww, a synchronous layer that encrypts individual values within the data structure itself. Durable Objects see the CRDT skeleton (key names like `tab-1`, timestamps for conflict resolution) but every value is an opaque ciphertext blob: `[formatVersion(1) ‖ keyVersion(1) ‖ nonce(24) ‖ ciphertext ‖ tag(16)]`. Yjs `writeAny` serializes `Uint8Array` natively as binary (type tag 116), so there is no base64 overhead.

The workspace encryption key derives from `ENCRYPTION_SECRETS`, not from Better Auth's auth secret. This is server-managed, deployment-level encryption: the same model used by Notion, Linear, and most SaaS products, but applied deeper (individual CRDT values rather than database-level). Better Auth keeps using `BETTER_AUTH_SECRET` for auth cookies, tokens, and OAuth state. The server can decrypt workspace data to power search indexing, AI summarization, and password recovery.

| Deployment | Key source | Who can decrypt | Trade-off |
|---|---|---|---|
| Epicenter Cloud | Derived from deployment secret | Epicenter infrastructure | Enables search, AI, password reset, device migration |
| Self-hosted | Same derivation, your secret | Only you | Functionally zero-knowledge. The key never leaves your infra |

Self-hosting makes this zero-knowledge in practice. The encryption key sits on a machine you control; Epicenter never sees it. Same binary, same API surface. The deployment is the trust boundary.

### Why not zero-knowledge?

Zero-knowledge means the server can't read your data. The cost: password recovery doesn't work (the server can't re-derive your key), search doesn't work (the server can't index ciphertext), AI doesn't work (the server can't read your notes to summarize them), and device migration requires a key transfer ceremony.

PGP has been trying to make key management practical for thirty years. Signal works because messaging is one-dimensional. The server is a relay that never processes content. Most apps aren't relays. Epicenter needs to search documents, run AI against notes, and let users reset passwords without losing everything.

### Overhead

Encryption adds a fixed 42 bytes per value (2-byte header + 24-byte nonce + 16-byte Poly1305 auth tag) with zero proportional expansion. Blobs are stored as raw `Uint8Array` via Yjs binary serialization. For typical workspace data (100 to 2000 byte values), total overhead is 2 to 42%. Performance impact is negligible. XChaCha20-Poly1305 via @noble/ciphers encrypts 1 KB in about 0.01 ms, and decrypting an entire workspace (500 entries) takes under 5 ms.

For the full argument:

- [Why E2E Encryption Keeps Failing](/docs/articles/why-e2e-encryption-keeps-failing.md): PGP, Signal, and the structural problem
- [Let the Server Handle Encryption](/docs/articles/let-the-server-handle-encryption.md): the pragmatic alternative
- [If You Don't Trust the Server, Become the Server](/docs/articles/if-you-dont-trust-the-server-become-the-server.md): self-hosting as the clean answer
- [Encrypted Workspace Storage spec](/specs/20260213T005300-encrypted-workspace-storage.md): implementation details

## Architecture

```
Cloudflare Workers
├── Hono app (src/app.ts)
│   ├── /auth/*          Better Auth (email/password, Google OAuth, OAuth provider)
│   ├── /ai/chat         AI streaming (OpenAI and Gemini via @tanstack/ai)
│   ├── /api/owners/:ownerId/rooms/:room
│   │                    Cloud doc sync (WebSocket upgrade or HTTP)
│   └── /api/owners/:ownerId/rooms/:room/dispatch
│                        Cross-device dispatch (HTTP POST)
│
└── Room (Durable Object, SQLite-backed)
    └── One Yjs document for one authorized sync room
```

API keys for AI providers are environment secrets (`wrangler secret put`). They never leave the hub. The client sends a session token, the hub validates it and swaps in the real key before forwarding to the provider.

## Development

Prerequisites: Bun, local PostgreSQL, and Infisical CLI authentication
(`infisical login`). `bun run dev` pipes secrets from Infisical's dev
environment into Wrangler via `process.env`, so Postgres alone is not enough.

### Local Postgres setup

The API needs a local PostgreSQL instance for development. The connection string is configured in `wrangler.jsonc` under the Hyperdrive `localConnectionString`.

```bash
brew install postgresql
brew services start postgresql

# Homebrew creates a role matching your macOS username. Create the postgres role and database:
psql -d postgres -c "CREATE ROLE postgres WITH LOGIN SUPERUSER PASSWORD 'postgres';"
psql -U postgres -c "CREATE DATABASE epicenter;"

# Push the schema
bun run db:push:local
```

### How database URLs work

There are three layers, each with a different URL source:

| Layer | Source | Used by |
|---|---|---|
| Local dev (runtime) | `wrangler.jsonc` Hyperdrive `localConnectionString` | `bun dev` (wrangler) |
| Local dev (drizzle-kit) | `LOCAL_DATABASE_URL` parsed from `wrangler.jsonc` | `db:push:local`, `db:studio:local` |
| Remote admin | `DATABASE_URL` injected by `infisical run` | `db:migrate:remote`, `db:studio:remote` |

`bun run dev` runs `infisical run -- wrangler dev` with a local-only `--var` override for `API_PUBLIC_ORIGIN`. Wrangler reads required auth bindings from the spawned process via the `secrets.required` config, including `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, so local OAuth uses the Google client stored in Infisical's dev environment. No `.dev.vars` file is produced. Remote database commands use `infisical run` against the prod environment and should be treated as admin operations, not dev mode.

### Running the server

```bash
bun dev              # Local dev server (uses local Postgres)
bun deploy           # Deploy to Cloudflare Workers
bun run typecheck    # Type check
bun test             # Run tests
```

### Database commands

```bash
bun run auth:generate    # Generate Better Auth schema
bun run db:generate      # Generate Drizzle migrations
bun run db:push:local     # Push schema to local Postgres (dev only, use migrations for remote)
bun run db:migrate:remote # Run migrations against remote (via Infisical)
bun run db:studio:local  # Open Drizzle Studio (local)
bun run db:studio:remote # Open Drizzle Studio (remote, via Infisical)
```

See `wrangler.jsonc` for Durable Object bindings, KV namespaces, and Hyperdrive (Postgres connection pool) configuration.

## License

[AGPL-3.0](../../licenses/LICENSE-AGPL-3.0). The sync server and sync protocol are AGPL so that anyone hosting a modified version shares their changes. Client libraries and apps are MIT. This follows the same pattern as Yjs (MIT core, AGPL y-redis), Liveblocks (Apache clients, AGPL server), and Bitwarden (GPL clients, AGPL server).
