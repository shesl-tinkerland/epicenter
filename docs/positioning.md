# Positioning

Canonical messaging for Epicenter. Every public surface should derive from this document: README, landing page, package descriptions, social posts.

## One-Liner

**Local-first apps. One workspace you own.** Capture in purpose-built apps. Read the generated Markdown. Query the SQLite mirror. Curate what matters into Markdown folders you can grep, version, and keep forever. Sync between devices when you want.

For developers: a CRDT-powered workspace engine that materializes app state to SQLite and Markdown, with typed schemas, validated actions, and multi-device sync. Not another note app: the infrastructure that lets apps belong to the same workspace.

*"PKM substrate" is accurate but too niche for a tagline. Use it in developer-facing contexts (blog posts, technical talks) but not in the README or landing page hero.*

## The Hook

Most tools store your data in their own silo. Epicenter gives purpose-built apps a shared local-first workspace: app data can be browsed as Markdown, queried through SQLite, and curated into folders you control. Your folders are ordinary Markdown: grep them, open them in Obsidian, version them with Git, publish them with whatever static site stack you like. Your transcripts can inform your notes. Your saved tabs can become drafts. Good captures graduate into your long-term workspace instead of staying trapped in the app that caught them.

Under the hood, app-owned state lives in Yjs, materializes to SQLite for fast queries, and materializes to Markdown for human-readable projections. User-owned folders stay ordinary Markdown. Sync happens over the Yjs protocol when you turn it on. Workspace sync sends encrypted CRDT values; hosted Epicenter uses server-managed keys, while self-hosting moves the key boundary to infrastructure you control.

## What Epicenter Is

- An **open-source, local-first workspace** for purpose-built apps and curated Markdown
- A **TypeScript library** (`@epicenter/workspace`) for building CRDT-backed apps with typed schemas, materializers, and actions
- A **CLI** (`epicenter`) for listing and invoking validated app actions, locally or on a peer that is online right now
- A **sync server** (AGPL, self-hostable) that relays encrypted CRDT updates between devices

## What Epicenter Is Not

- Not a single app (purpose-built apps are the capture surfaces)
- Not cloud-first (local-first by default, sync is optional)
- Not a Notion or Obsidian clone (it is the workspace layer beneath capture, curation, and publishing tools)

## Core Claims (Verifiable)

Every claim we make publicly should be provable by inspecting the repo:

| Claim | Proof |
|---|---|
| "Readable Markdown and queryable SQLite" | Markdown materializers write `.md` files with YAML frontmatter. SQLite materializers keep rebuildable query mirrors. |
| "A workspace you own" | The local project layout separates user-owned folders from generated app projections and hidden machine state. |
| "CRDT-powered sync" | App-owned live state uses Yjs documents; sync uses the Yjs protocol over WebSocket. |
| "Encrypted CRDT values" | `XChaCha20-Poly1305` via `@noble/ciphers`; HKDF-SHA256 key derivation. Workspace values are encrypted before they enter the synced Yjs document. |
| "Self-hostable" | Sync server is open source under AGPL. Run it on your infrastructure, control the encryption keys. |
| "Bring your own model" | AI features use user-provided API keys. No middleman, no proxy required. |

## Competitor Positioning

### vs Obsidian
> Obsidian is a markdown editor with sync. Epicenter is the local-first workspace where purpose-built apps produce readable projections and curated Markdown stays yours.

- **Win**: App output can become durable workspace material without living in per-plugin storage. CRDT sync instead of file-level conflict resolution.
- **Lose**: Obsidian's plugin ecosystem and years of UX polish. We're earlier.

### vs Anytype
> Anytype is a purpose-built encrypted space ecosystem. Epicenter is the Yjs-backed workspace model for local-first app data, readable projections, and curated Markdown.

- **Win**: Standard CRDT stack (Yjs, widely adopted and battle-tested) vs custom protocol. Developer-facing API with typed schemas, not just an end-user app.
- **Lose**: Anytype's product is more complete today. Their P2P sync story is more mature.

### vs Logseq
> Logseq is an outliner-first app. Epicenter is the structured local-first storage engine that can power outline UIs without trapping data in a single app.

- **Win**: SQL plus structured schemas. Purpose-built capture tools can project into a workspace you control. Encrypted CRDT values for sync.
- **Lose**: Logseq's block/journal UX is more native. Larger community.

### vs Standard Notes
> Standard Notes secures your notes. Epicenter secures a whole local-first workspace that multiple apps share, with CRDTs, schemas, and materialized exports.

- **Win**: Platform, not just "notes." Structured data with schemas. Materialized to files you can inspect.
- **Lose**: Standard Notes' encryption UX is simpler to communicate. They've earned trust over years.

### vs Notion
> Notion is where your knowledge lives. Epicenter is where your knowledge stays.

- **Win**: Offline-first, local-first, open source, no cloud lock-in.
- **Lose**: Notion's UX, templates, collaboration, and distribution are years ahead.

### vs Karpathy's "Second Brain" System
> Karpathy showed the folder. Epicenter is the local-first app layer around it.

- **Win**: CRDT sync across devices, typed schemas, encryption, CLI automation: everything raw folders can't do.
- **Lose**: Karpathy's system wins on simplicity. A folder of markdown files needs zero infrastructure.

### vs Jazz
> Jazz syncs slices of a shared database to everyone. Epicenter materializes one whole workspace into a folder that belongs to you.

The two stacks converged from opposite premises: typed tables, query subscriptions, local-first writes, collaborative text. The difference is scope. Jazz is a multi-user relational database with partial replication and row-level permissions. Epicenter is hyper-focused on personal apps, so a workspace is a full local replica, the unit of sharing is the folder, and we refuse partial sync, row permissions, and snapshotting on purpose. That refusal is what lets us build on Yjs and open standards instead of a custom sync engine. See [the long form](articles/20260531T160000-i-kept-reinventing-jazz-the-win-is-what-we-refuse.md).

- **Win**: One folder you own, plain text and SQLite you can grep without the app, built on standard Yjs rather than a private protocol. Less to learn because the scope is smaller.
- **Lose**: Jazz scales to large shared datasets and multi-user row-level access that Epicenter deliberately won't. For a synced multi-user app database, Jazz is the better tool and further along.

## Headlines and Hooks

### Hacker News
1. "A local-first PKM substrate: CRDT-powered tables that materialize to SQLite and markdown"
2. "Local-first apps. One workspace you own."
3. "CRDTs + plain files: offline-first notes without sync nightmares"

### Twitter/X
1. "Your notes shouldn't depend on a vendor. Here's the CRDT-based way to keep them in a folder"
2. "Capture in purpose-built apps. Curate the good parts into folders that are yours forever."
3. "Notion stores knowledge in the cloud. Epicenter stores it in your folder"

### Karpathy Angle (strongest entry point)
Karpathy's "second brain" post (41K bookmarks) describes: three folders of .md files + a schema file (CLAUDE.md) + AI organizes everything. Epicenter is the infrastructure version of that system, with the same philosophy (local files, AI organizes, no cloud lock-in), but with real sync, real schemas, real encryption, and a CLI that makes "compile the wiki" a single command.

## Keywords

### Use These
`local-first`, `CRDT`, `Yjs`, `offline-first`, `own your data`, `conflict-free sync`, `personal knowledge base`, `PKM`, `second brain`, `plain text`, `SQLite`, `markdown`, `self-hosted`, `open source`, `encrypted sync`, `multi-device sync`, `materialize`, `workspace`

### Avoid These
`AI-native`, `agentic`, `next-gen`, `revolutionary`, `redefine`, `game changer`, `Web3`, `metaverse`, buzzword-stacking ("CRDT-powered AI-first encrypted next-gen offline-first workspace": say less, prove more)

## Package Descriptions

Canonical descriptions for packages that appear on public front-door surfaces:

| Package | Description |
|---|---|
| `@epicenter/workspace` | Local-first workspace engine. CRDT-powered tables that materialize to SQLite and Markdown, with typed schemas and multi-device sync. |
| `@epicenter/cli` | CLI for Epicenter workspaces. List actions, run them against the local daemon, dispatch them to online peers, and manage the project daemon. |
| `@epicenter/sync` | Yjs-based sync protocol for Epicenter. Handles CRDT document exchange, awareness, and RPC over WebSocket. |
| `@epicenter/filesystem` | Filesystem operations for Epicenter workspaces. Read, write, and watch plain text and Markdown files. |
| `@epicenter/ui` | Shared UI components for Epicenter apps. Built with Svelte 5 and shadcn-svelte. |
| `@epicenter/server` | Shared Hono server library for hosted Epicenter and self-hosted deployments. |

## Keywords per Package

| Package | Keywords |
|---|---|
| `@epicenter/workspace` | `local-first`, `CRDT`, `Yjs`, `offline-first`, `SQLite`, `markdown`, `personal knowledge base`, `PKM`, `second brain`, `sync`, `workspace`, `typed schema` |
| `@epicenter/cli` | `local-first`, `CLI`, `workspace`, `CRDT`, `offline-first`, `PKM`, `terminal` |
| `@epicenter/sync` | `Yjs`, `CRDT`, `sync`, `WebSocket`, `offline-first`, `local-first`, `real-time` |
| `@epicenter/filesystem` | `local-first`, `filesystem`, `workspace`, `CRDT`, `markdown` |
| `@epicenter/ui` | `Svelte`, `components`, `shadcn-svelte`, `workspace` |
| `@epicenter/server` | `Hono`, `Cloudflare Workers`, `sync`, `self-hosted`, `workspace` |
