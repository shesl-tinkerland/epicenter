# Opensidian E2E

Syncs the Opensidian workspace from the Epicenter API down to local files. The daemon persists file metadata to SQLite and materializes each note as a `.md` file with YAML frontmatter (metadata) and markdown body (document content).

## Prerequisites

Log in to the Epicenter API first:

```bash
# Production (server URL defaults to https://api.epicenter.so)
epicenter auth login

# Local dev (requires apps/api running)
bun epicenter auth login http://localhost:8787
```

This stores your credentials at `<dataDir>/auth/<host>.json`, where `dataDir` is the platform user-data directory from `env-paths('epicenter')` (for example, `~/Library/Application Support/epicenter/auth/api.epicenter.so.json` on macOS). See `packages/cli/README.md` for the per-target layout.

## Usage

This playground uses a project-local mount module rather than a packaged app
mount factory. `epicenter.config.ts` default-exports that mount explicitly;
`workspaces/` is not scanned automatically.

Run the workspace:

```bash
# Production (syncs from api.epicenter.so)
epicenter daemon up -C playground/opensidian-e2e

# Local dev (syncs from localhost:8787)
EPICENTER_API_URL=http://localhost:8787 \
  epicenter daemon up -C playground/opensidian-e2e
```

Daemon startup imports the mounts declared by `epicenter.config.ts`. When that
config points at `workspaces/opensidian/daemon.ts`, the daemon kicks off
persistence, sync, markdown materialization, and the SQLite mirror. The process
stays alive until Ctrl+C or `epicenter daemon down`.

Invoke a defined action:

```bash
# Scan a directory for markdown files and inject IDs into frontmatter.
epicenter run opensidian.markdown_prepare '{"directory":"./some/dir"}' \
  -C playground/opensidian-e2e
```

Inspect workspace data from a script by importing the app workspace package or a script-specific helper. Do not import `workspaces/opensidian/daemon.ts` as a reusable client module; it is the long-lived mount entrypoint. If this playground needs table-level scripts, first extract the composition into a `script.ts` helper and let both the script and mount call that helper.

```ts
// scripts/list-files.ts
import { openOpensidianForScript } from '../playground/opensidian-e2e/script';

try {
  const opensidian = await openOpensidianForScript();
  await opensidian.whenReady;
  console.log(`files: ${opensidian.tables.files.count()}`);
  for (const row of opensidian.tables.files.getAllValid()) {
    console.log(`  ${row.id}: ${row.name}`);
  }
} finally {
  opensidian.dispose();
}
```

```bash
bun run scripts/list-files.ts
```

## What it produces

```
playground/opensidian-e2e/
├── epicenter.config.ts              # Required by the current daemon loader
├── workspaces/
│   └── opensidian/
│       └── daemon.ts                  # Project-local mount module
└── .epicenter/
    ├── yjs/
    │   ├── opensidian.db              # Yjs CRDT update log (source of truth)
    │   └── <contentDocGuid>.db        # One log per file content document
    ├── sqlite/
    │   └── opensidian.db              # Queryable SQLite mirror (sqlite3 / FTS5)
    └── md/
        └── opensidian/
            └── files/
                ├── my-first-note-abc123.md
                └── meeting-notes-def456.md
```

The Yjs log is the source of truth; SQLite and markdown are projections the materializer keeps in sync. See `packages/workspace/src/document/workspace-paths.ts`.

Each `.md` file looks like:

```markdown
---
id: abc123
name: my-first-note.md
parentId: folder-id-xyz
size: 0
createdAt: 1712300000000
updatedAt: 1712300000000
trashedAt: null
---

# My First Note

The actual document content from the editor.
```

## How it works

The project mount chains four extensions onto the Opensidian workspace:

1. **Persistence**: workspace-only SQLite. Persists the files table so it survives daemon restarts without re-downloading everything from the server.

2. **Markdown materializer**: custom one-way projection (Y.Doc to files). Observes the files table; for each file, reads document content via `documents.files.content.open(id)` and writes a `.md` file with frontmatter + body. Document content changes trigger `updatedAt` on the row, which fires the observer and re-materializes.

3. **Encryption unlock**: reads encryption keys from the CLI session store so encrypted fields can be decrypted locally.

4. **Sync**: WebSocket connection to the Epicenter API for real-time data sync.

## Running alongside Opensidian

You can run the daemon while Opensidian is open in your browser. Both connect to the same Epicenter API via WebSocket sync, so changes in the app appear as materialized `.md` files within seconds. The daemon is read-only: it doesn't write back to the workspace from disk changes.
