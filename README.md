<p align="center">
  <a href="https://epicenter.so">
    <img width="200" src="https://github.com/user-attachments/assets/9e210c52-2740-43b6-af3f-e6eaf4b5c397" alt="Epicenter">
  </a>
  <h1 align="center">Epicenter</h1>
  <p align="center"><strong>Local-first apps. One workspace you own.</strong></p>
  <p align="center">Capture in purpose-built apps. Read the generated Markdown. Query the SQLite mirror.<br>Curate what matters into Markdown folders you can grep, version, and keep forever. Sync between devices when you want.</p>
  <p align="center">Whispering is downloadable today. A workspace-native refresh of Whispering is in progress, and the shared workspace for tabs, notes, drafts, and publishing is being built in public on <code>@epicenter/workspace</code>.</p>
</p>

<p align="center">
  <a href="https://github.com/EpicenterHQ/epicenter" target="_blank">
    <img alt="GitHub stars" src="https://img.shields.io/github/stars/EpicenterHQ/epicenter?style=flat-square" />
  </a>
  <a href="https://github.com/EpicenterHQ/epicenter/releases/latest" target="_blank">
    <img alt="Latest release" src="https://img.shields.io/github/v/release/EpicenterHQ/epicenter?style=flat-square&label=Latest%20Release&color=brightgreen" />
  </a>
  <a href="LICENSE" target="_blank">
    <img alt="License" src="https://img.shields.io/github/license/EpicenterHQ/epicenter.svg?style=flat-square" />
  </a>
  <a href="https://go.epicenter.so/discord" target="_blank">
    <img alt="Discord" src="https://img.shields.io/badge/Discord-Join%20us-5865F2?style=flat-square&logo=discord&logoColor=white" />
  </a>
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
  <a href="#install-whispering">Install</a> |
  <a href="#build-with-the-toolkit">Toolkit</a> |
  <a href="#how-it-works">How It Works</a> |
  <a href="#status">Status</a> |
  <a href="#trust-boundaries">Trust</a> |
  <a href="#repo-map">Repo Map</a> |
  <a href="#development">Development</a> |
  <a href="#license">License</a>
</p>

---

## Install Whispering

[Whispering](apps/whispering) is the first shipped app in the Epicenter repo: a desktop speech-to-text tool for macOS, Windows, and Linux.

```bash
brew install --cask whispering
```

On Windows and Linux, download the installer from the [latest release](https://github.com/EpicenterHQ/epicenter/releases/latest).

Press a shortcut, speak, optionally transform the transcript, and paste the result where you were working. No Epicenter account is required. You can run local Whisper C++ for offline transcription, or bring your own API key for providers like Groq, OpenAI, and ElevenLabs.

[Install Whispering](apps/whispering#install-whispering) | [Download latest release](https://github.com/EpicenterHQ/epicenter/releases/latest)

## Build With The Toolkit

The hard problem with local-first apps is synchronization. If each device has its own SQLite file or Markdown folder, how do you keep them in sync? [`@epicenter/workspace`](packages/workspace) answers by making Yjs the source of truth, then projecting app state to SQLite for queries and Markdown for reading.

The package gives apps typed tables, local persistence, materializers, collaboration hooks, and validated actions.

```typescript
import { column, createWorkspace, defineTable } from '@epicenter/workspace';

const notes = defineTable({
  id: column.string(),
  title: column.string(),
  body: column.string(),
});

const workspace = createWorkspace({
  id: 'notes',
  tables: { notes },
  kv: {},
});

workspace.tables.notes.set({
  id: '1',
  title: 'Hello',
  body: 'Follow up on the README framing.',
});

// Materializers can project that row to Markdown files and SQLite rows.
```

[Read the workspace package docs](packages/workspace/README.md)

## How It Works

Epicenter separates app-owned data from user-owned Markdown. The model is being built in public; [Matter](apps/matter) is the current WIP front for the folders-you-own side: a typed grid that edits ordinary Markdown folders directly. It does not write into `apps/<name>/`.

```txt
workspace/
|-- apps/<name>/        generated app projections; read, grep, quote, copy
|-- .epicenter/         machine state; ignore
|-- journal/            your Markdown; edit, commit, curate, publish
|-- ideas/              your Markdown
`-- publish/            your publishable artifacts
```

The rule is simple: `apps/<name>/` is for reading app output, not hand-editing it. To change app data, use the app or a validated CLI action. To keep something forever, copy it into a folder you own.

Your folders are ordinary Markdown: grep them, open them in Obsidian, version them with Git, publish them with whatever static site stack you like.

```txt
purpose-built app
  -> Yjs live state
  -> Markdown projection for human reading
  -> SQLite mirror for local queries
  -> curated Markdown when something is worth keeping
```

Yjs handles live app state, offline edits, and multi-device sync. SQLite gives scripts and views a fast query surface. Markdown gives you files you can read, quote, copy, version, and publish.

A generated Markdown projection is meant to be boring on purpose (this is the target shape):

```md
---
id: note_123
title: Morning capture
source: app
updatedAt: "2026-06-10T16:49:59.180Z"
---
Follow up on the README framing.
```

Matter already implements this pattern for the folders you own: it keeps a disposable `matter.sqlite` mirror of each managed folder, so agents and scripts can query your Markdown as SQL:

```bash
sqlite3 matter.sqlite 'select "name" from "journal" limit 5;'
```

## Status

Whispering is the first shipped app: install it today on macOS, Windows, or Linux. A larger workspace-native refresh of Whispering is in progress, and current installs will receive it through the normal release path.

The shared workspace for tabs, notes, drafts, and publishing is being built in public around `@epicenter/workspace`. [Matter](apps/matter) is the current WIP front for the folders-you-own side: it edits ordinary Markdown folders and keeps `matter.sqlite` as a query mirror. Other app folders are public research and prototypes.

## Trust Boundaries

Pick the trust model you want.

| Path | What leaves your device |
| --- | --- |
| Whispering with local Whisper C++ | Audio can stay on your device. Transcripts and settings are stored locally by the desktop app. |
| Whispering with a cloud transcription provider | Audio goes from your device to the provider you choose. Epicenter servers are not in that transcription path. |
| Whispering transformations | Transcript text goes to the LLM provider you choose when you enable that step. |
| Hosted Epicenter API or sync | Encrypted workspace updates, account/session data, and enabled hosted feature requests go to Epicenter servers. |
| Self-hosted deployable | You control the server, secrets, deployment, and infrastructure boundary. |

Signed-in workspace sync sends encrypted CRDT values over Yjs. On hosted Epicenter, encryption keys are server-managed; self-hosting moves the key boundary to infrastructure you control. See the [encryption design](docs/encryption.md) for the full trust model.

The detailed privacy notes for Whispering live in [apps/whispering](apps/whispering).

## Repo Map

### Product And Workspace Surfaces

| Surface | Status | Notes |
| --- | --- | --- |
| [Whispering](apps/whispering) | Installable app | Desktop speech-to-text with local and bring-your-own-provider transcription paths. |
| [Matter](apps/matter) | WIP product work | Typed grid for user-owned Markdown folders. It edits ordinary `.md` files directly; `matter.sqlite` is a disposable query mirror. |
| [API](apps/api) | Hosted infrastructure | Personal cloud Worker for hosted Epicenter services. Includes hosted-only billing and dashboard code. |
| [Self-host](apps/self-host) | Reference deployable | Community-supported shared wiki deployable without hosted billing. |
| Other app folders | Research and prototypes | Useful history and experiments, not the current product lineup. |

### Packages

These packages carry the main architecture.

| Package | Role | License |
| --- | --- | --- |
| [`@epicenter/workspace`](packages/workspace) | Core workspace primitives: typed schemas, Yjs documents, local persistence, materializers, actions, and collaboration hooks. | MIT |
| [`@epicenter/sync`](packages/sync) | Yjs sync protocol encoding and decoding. Protocol framing lives separately from transport. | MIT |
| [`@epicenter/ui`](packages/ui) | Shared Svelte component library used by multiple app surfaces. | MIT |
| [`@epicenter/filesystem`](packages/filesystem) | POSIX-style virtual filesystem helpers over workspace data. | MIT |
| [`@epicenter/server`](packages/server) | Shared Hono server library composed by the hosted API and self-host reference deployable. | AGPL-3.0-or-later |
| [`@epicenter/cli`](packages/cli) | The `epicenter` command and local or hosted API workflows. | AGPL-3.0-or-later |

## Architecture

The server side is split into one shared library and two deployable folders:

```txt
packages/server
  shared Hono library
  route composition for auth, sessions, rooms, assets, and provider-backed APIs

apps/api
  hosted personal Cloudflare Worker
  composes packages/server with personal()
  owns hosted-only dashboard and billing code

apps/self-host
  self-hosted shared wiki reference deployable
  composes packages/server with shared({ admit })
  community-supported
  no hosted billing surface
```

[Full architecture walkthrough](docs/architecture.md) | [Encryption design](docs/encryption.md)

## Development

Use Bun in this repo.

```bash
git clone https://github.com/EpicenterHQ/epicenter.git
cd epicenter
bun install
```

Root `bun dev` starts the current default local workflow: the API and Tab Manager.

```bash
bun dev
bun run dev:api
bun run dev:tab-manager:ui
```

See [apps/api/README.md](apps/api/README.md) for local Postgres and Infisical setup. Rust is needed for Tauri surfaces such as Whispering and Matter.

Useful checks:

```bash
bun run typecheck
bun run test
bun run check
```

## Design Notes

Implementation specs and design notes live in [specs/](specs). Start with [docs/README.md](docs/README.md), [specs/README.md](specs/README.md), and the current front-door plan in [specs/20260610T173324-root-readme-public-front-door.md](specs/20260610T173324-root-readme-public-front-door.md).

## Contributing

Contributions are welcome. Good entry points are docs, Whispering fixes, local-first infrastructure, Svelte interfaces, and small changes that make the repo easier to understand.

[Read the Contributing Guide](CONTRIBUTING.md)

Contributors coordinate in [Discord](https://go.epicenter.so/discord).

## License

Epicenter uses a two-tier split:

- [MIT](licenses/LICENSE-MIT) for the local-first-on-Yjs developer toolkit: `@epicenter/workspace`, `@epicenter/ui`, `@epicenter/filesystem`, and `@epicenter/sync`.
- [AGPL-3.0](licenses/LICENSE-AGPL-3.0) or later for non-toolkit app surfaces, hosted server code, and internal packages.
- Proprietary is a deferred, empty tier. Revenue is intended to come from hosting and services, not from selling closed licenses.

The toolkit dependency closure is MIT, enforced by `bun run check:licenses`. The license split follows the same broad pattern as Plausible and PostHog for hosted open-source services, and Yjs for MIT core libraries with copyleft server pieces.

See the root [LICENSE](LICENSE), [FINANCIAL_SUSTAINABILITY.md](FINANCIAL_SUSTAINABILITY.md), and [licensing strategy spec](specs/20260428T120000-licensing-strategy.md) for the full model.

---

<p align="center">
  <strong>Contact:</strong> <a href="mailto:github@bradenwong.com">github@bradenwong.com</a> | <a href="https://go.epicenter.so/discord">Discord</a> | <a href="https://twitter.com/braden_wong_">@braden_wong_</a>
</p>

<p align="center">
  <sub>Local-first | Own your data | Markdown | SQLite | Yjs | Open source</sub>
</p>
