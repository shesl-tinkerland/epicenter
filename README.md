<p align="center">
  <a href="https://epicenter.so">
    <img width="200" src="https://github.com/user-attachments/assets/9e210c52-2740-43b6-af3f-e6eaf4b5c397" alt="Epicenter">
  </a>
  <h1 align="center">Epicenter</h1>
  <p align="center">Local-first, open-source apps</p>
  <p align="center">One folder of plain text and SQLite on your machine, synced across all your devices.<br>Grep it, query it, host it wherever you want.</p>
</p>

<p align="center">
  <!-- GitHub Stars Badge -->
  <a href="https://github.com/EpicenterHQ/epicenter" target="_blank">
    <img alt="GitHub stars" src="https://img.shields.io/github/stars/EpicenterHQ/epicenter?style=flat-square" />
  </a>
  <!-- Latest Version Badge -->
  <img src="https://img.shields.io/github/v/release/EpicenterHQ/epicenter?style=flat-square&label=Latest%20Version&color=brightgreen" />
  <!-- License Badge -->
  <a href="LICENSE" target="_blank">
    <img alt="License" src="https://img.shields.io/github/license/EpicenterHQ/epicenter.svg?style=flat-square" />
  </a>
  <!-- Discord Badge -->
  <a href="https://go.epicenter.so/discord" target="_blank">
    <img alt="Discord" src="https://img.shields.io/badge/Discord-Join%20us-5865F2?style=flat-square&logo=discord&logoColor=white" />
  </a>
  <!-- Platform Support Badges -->
  <a href="https://github.com/EpicenterHQ/epicenter/releases" target="_blank">
    <img alt="macOS" src="https://img.shields.io/badge/-macOS-black?style=flat-square&logo=apple&logoColor=white" />
  </a>
  <a href="https://github.com/EpicenterHQ/epicenter/releases" target="_blank">
    <img alt="Windows" src="https://img.shields.io/badge/-Windows-blue?style=flat-square&logo=windows&logoColor=white" />
  </a>
  <a href="https://github.com/EpicenterHQ/epicenter/releases" target="_blank">
    <img alt="Linux" src="https://img.shields.io/badge/-Linux-yellow?style=flat-square&logo=linux&logoColor=white" />
  </a>
</p>

<p align="center">
  <a href="#apps">Apps</a> •
  <a href="#for-developers">For Developers</a> •
  <a href="#where-were-headed">Vision</a> •
  <a href="#contributing">Contributing</a> •
  <a href="https://go.epicenter.so/discord">Discord</a>
</p>

---

## What is Epicenter?

Epicenter is an ecosystem of open-source, local-first apps. All your data—notes, transcripts, chat histories—lives in a single folder of plain text and SQLite on your machine. Every tool we build reads and writes to the same place. It's open, tweakable, and yours. Grep it, open it in Obsidian, version it with Git, host it wherever you want.

Under the hood, Yjs CRDTs are the single source of truth. They materialize *down* to SQLite (for fast queries) and markdown (for human-readable files). Sync happens over the Yjs protocol; the server is a relay, not an authority—it never sees your content.

The library that powers this, [`@epicenter/workspace`](packages/workspace), is something other developers can build on too. Define a typed schema, get CRDT-backed tables with multi-device sync handled for you.

## Apps

<table>
  <tr>
    <td align="center" width="50%">
      <h3><a href="apps/whispering">Whispering</a></h3>
      <p>Press shortcut, speak, get text. Desktop transcription that cuts out the middleman. Bring your own API key or run locally with Whisper C++.</p>
      <p><strong><a href="apps/whispering">Source</a></strong> · <strong><a href="apps/whispering#install-whispering">Install</a></strong></p>
    </td>
    <td align="center" width="50%">
      <h3><a href="apps/tab-manager">Tab Manager</a></h3>
      <p>Chrome extension for saving tabs as bookmarks and building a read-later list, all stored in the shared workspace.</p>
      <p><strong><a href="apps/tab-manager">Source</a></strong></p>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <h3><a href="apps/api">Epicenter API</a></h3>
      <p>The hub server. Handles authentication, real-time sync via Durable Objects, and AI inference. Everything that needs a single authority across devices.</p>
      <p><strong><a href="apps/api">Source</a></strong></p>
    </td>
    <td align="center" width="50%">
      <h3>Build your own</h3>
      <p>The <a href="packages/workspace"><code>@epicenter/workspace</code></a> library makes it straightforward to build apps that share the same CRDT-backed data. Define a schema, get tables, add sync.</p>
    </td>
  </tr>
</table>

## For Developers

The hard problem with local-first apps is synchronization. If each device has its own SQLite file, how do you keep them in sync? If each device has its own markdown folder, same question. We ended up using Yjs CRDTs as the single source of truth, then materializing that data *down* to SQLite (for fast SQL reads) and markdown (for human-readable files). Yjs handles the sync; SQLite and markdown handle the reads.

The [`@epicenter/workspace`](packages/workspace) package wraps this into a single API. Define a schema, get CRDT-backed tables, attach providers to materialize to SQLite or markdown, and add sync when you're ready.

```typescript
import { defineWorkspace, createClient, id, text, boolean, select } from '@epicenter/workspace';

const workspace = defineWorkspace({
  id: 'blog',
  tables: {
    posts: {
      id: id(),
      title: text(),
      published: boolean({ default: false }),
      category: select({ options: ['tech', 'personal'] }),
    },
  },
  kv: {},
});

const client = createClient(workspace.id)
  .withDefinition(workspace)
  .withExtension('persistence', setupPersistence)
  .withExtension('sqlite', (c) => sqliteProvider(c));

// Write to the Y.Doc — SQLite updates automatically
client.tables.get('posts').upsert({ id: '1', title: 'Hello', published: false, category: 'tech' });
```

Each user gets their own database. Schema definitions are plain JSON, so they work with MCP and OpenAPI out of the box. Write to Yjs and SQLite updates; edit a markdown file and the CRDT merges it in.

**[Read the full workspace docs →](packages/workspace/README.md)**

## Where We're Headed

More apps are coming—notes, an AI assistant, and others—all sharing the same workspace. The architecture already supports it; the [`@epicenter/workspace`](packages/workspace) library handles the hard parts (schemas, CRDT sync, materialization), so each new app is mostly UI.

Epicenter Cloud will provide hosted sync for people who don't want to run their own server. Same model as Supabase selling hosted Postgres or Liveblocks selling hosted collaboration. Self-hosting is and will remain first-class—the sync server is open source under AGPL, and when you run it yourself, you control the encryption keys and trust boundary.

## Quick Start

### Install Whispering

```bash
brew install --cask whispering
```

Or download directly from [GitHub Releases](https://github.com/EpicenterHQ/epicenter/releases/latest) for macOS (.dmg), Windows (.msi), or Linux (.AppImage, .deb, .rpm).

**[Full installation guide →](apps/whispering#install-whispering)**

### Build from Source

```bash
# Prerequisites: Bun (https://bun.sh) and Rust (https://rustup.rs)
git clone https://github.com/EpicenterHQ/epicenter.git
cd epicenter
bun install
cd apps/whispering
bun dev
```

### Troubleshooting

If things break after switching branches or pulling changes:

```bash
bun clean    # Clears caches and node_modules
bun install  # Reinstall dependencies
```

For a full reset including Rust build artifacts (~10GB, takes longer to rebuild):

```bash
bun nuke     # Clears everything including Rust target
bun install
```

You rarely need `bun nuke`—Cargo handles incremental builds well. Use `bun clean` first.

## Contributing

We're looking for contributors who are passionate about open source, local-first software, or just want to build with Svelte and TypeScript.

**[Read the Contributing Guide →](CONTRIBUTING.md)**

Contributors coordinate in our [Discord](https://go.epicenter.so/discord).

## Tech Stack

<p align="center">
  <img alt="Svelte 5" src="https://img.shields.io/badge/-Svelte%205-orange?style=flat-square&logo=svelte&logoColor=white" />
  <img alt="Tauri" src="https://img.shields.io/badge/-Tauri-blue?style=flat-square&logo=tauri&logoColor=white" />
  <img alt="TypeScript" src="https://img.shields.io/badge/-TypeScript-blue?style=flat-square&logo=typescript&logoColor=white" />
  <img alt="Rust" src="https://img.shields.io/badge/-Rust-orange?style=flat-square&logo=rust&logoColor=white" />
  <img alt="Yjs" src="https://img.shields.io/badge/-Yjs-green?style=flat-square" />
  <img alt="Cloudflare Workers" src="https://img.shields.io/badge/-Cloudflare%20Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white" />
  <img alt="Tailwind CSS" src="https://img.shields.io/badge/-Tailwind%20CSS-38B2AC?style=flat-square&logo=tailwind-css&logoColor=white" />
</p>

## License

Most packages and all apps are [MIT](licenses/LICENSE-MIT)—use them however you want, no strings attached. The sync server (`apps/api`) and sync protocol (`packages/sync`) are [AGPL-3.0](licenses/LICENSE-AGPL-3.0), which means anyone hosting a modified version shares their changes. This follows the same pattern as Yjs (MIT core, AGPL y-redis), Liveblocks (Apache clients, AGPL server), and Bitwarden (GPL clients, AGPL server).

See [FINANCIAL_SUSTAINABILITY.md](FINANCIAL_SUSTAINABILITY.md) for the full reasoning behind the split.

---

<p align="center">
  <strong>Contact:</strong> <a href="mailto:github@bradenwong.com">github@bradenwong.com</a> | <a href="https://go.epicenter.so/discord">Discord</a> | <a href="https://twitter.com/braden_wong_">@braden_wong_</a>
</p>

<p align="center">
  <sub>Local-first · CRDT · Own your data · Open source</sub>
</p>
