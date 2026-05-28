# `@examples/fuji`

The canonical Epicenter project layout demonstrated against `@epicenter/fuji`.

## What this shows

One project, one workspace, defined inline in `epicenter.config.ts`. Table
data lives as markdown at the project root and is committed to git. Runtime
state (Yjs persistence, SQLite materializer) lives under `.epicenter/` and is
gitignored.

This example is the reference implementation of the layout spec at
`specs/20260522T220000-workspace-project-layout.md`. If the spec changes,
this example changes with it.

## Layout

```
examples/fuji/
├── package.json           dependencies (this file)
├── tsconfig.json          extends the repo base
├── epicenter.config.ts    REQUIRED. Marker + mount factory call.
├── .gitignore             Epicenter-managed (.epicenter/)
├── entries/               table data as markdown (committed)
│   ├── welcome.md
│   └── hello-fuji.md
└── .epicenter/            created on first daemon run; gitignored
    ├── yjs/
    │   └── epicenter.fuji.db
    └── sqlite.db
```

## Run it

```sh
bun install
bun x epicenter daemon up -C examples/fuji
```

On first run the daemon creates `.epicenter/` and writes `sqlite.db` plus the
Yjs persistence file used by `attachProjectInfrastructure`. The current mount
materializes the live Y.Doc out to markdown and SQLite. The project-layout
spec's next step is markdown-to-Y.Doc hydration, where files in `entries/`
become the human-editable source that can rebuild the runtime cache.

## Inspect the SQL mirror

```sh
sqlite3 examples/fuji/.epicenter/sqlite.db
sqlite> .tables
sqlite> SELECT id, title FROM entries;
```

The SQLite mirror is regenerable from `yjs.db`, which is regenerable from
the markdown in `entries/`. Anything under `.epicenter/` can be deleted; the
daemon will rebuild it on next run.

## Edit a note

Today, edit through mount actions or a connected Fuji runtime and watch the
markdown and SQLite projections update. The reverse direction, editing
`entries/*.md` and having the daemon ingest it back into the Y.Doc, is the
planned markdown hydration work described in the project-layout spec.

You can also drive changes through the daemon's RPC actions. Use the CLI:

```sh
bun x epicenter run fuji.entries_get '{"id":"01HM0000000000000000000000"}' -C examples/fuji
```

The action set is defined by `@epicenter/fuji` and re-exposed through this
example's `epicenter.config.ts`.

## Add a new entry

Current path:

1. **Call a mutation.** Use the CLI's `run` subcommand to invoke the
   workspace's create action.

Planned path: create `entries/my-new-entry.md` with the same frontmatter shape
as the existing examples, then let markdown hydration ingest it into the
workspace.

## What this example deliberately omits

- Auth and sync. The example is local-only; no `epicenter auth login` step.
- Browser or Tauri frontend. The example is daemon-hosted only.
- Custom path overrides. Materializer paths use the spec's default
  (`.epicenter/sqlite.db` and `./entries/`).
- Multi-workspace orchestration. One workspace per project is the canonical
  shape; multi-workspace is a monorepo with sibling projects.

## See also

- `specs/20260522T220000-workspace-project-layout.md` for the full spec.
- `examples/notes-cross-peer/` for a two-peer sync demo (predates this layout).
- `apps/fuji/` for the full Tauri/Svelte app that consumes the same workspace.
