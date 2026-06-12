# Scripting

A script is a Bun file that reads the local SQLite materializer and writes through `connectDaemonActions`. There is no `script.ts` recipe to copy. The daemon is the single writer; the script is a short-lived reader plus an IPC client.

Mount names come from the `Mount.name` values default-exported by `epicenter.config.ts`, not from project folders or local module filenames. One daemon process can serve many mounts, and the script chooses one with `connectDaemonActions({ mount })`.

## The whole shape

```ts
import {
  connectDaemonActions,
  findProjectRoot,
  openSqliteReader,
} from "@epicenter/workspace/node";
import type { FujiActions } from "@epicenter/fuji";
import { join } from "node:path";

const projectDir = findProjectRoot();

// reads: open the materializer read-only
const db = openSqliteReader({
  filePath: join(projectDir, ".epicenter/sqlite.db"),
});
const urgent = db
  .query(
    "SELECT * FROM entries WHERE EXISTS (SELECT 1 FROM json_each(entries.tags) WHERE value = ?)",
  )
  .all("urgent");

// writes: typed proxy over unix socket to the daemon
const fuji = await connectDaemonActions<FujiActions>({
  mount: "fuji",
  projectDir,
});
for (const note of urgent) {
  await fuji.entries_update({ id: note.id, tags: ["triaged"] });
}

db.close();
```

That is the whole API. No machine auth in the script process, no encryption setup, no Y.Doc reconstruction, no WebSocket.

## Reads: the SQLite materializer

Use `openSqliteReader({ filePath })` when a mount overrides its SQLite path, as
the Fuji example does with `.epicenter/sqlite.db`. `openWorkspaceSqlite(projectDir,
workspaceId)` only opens the convention path
`.epicenter/sqlite/<workspaceId>.db`; it does not inspect `epicenter.config.ts` and
is not override-aware. `.epicenter/` is generated project data, not a source layout
or route registry. The daemon's `attachBunSqliteMaterializer` keeps that file fresh;
the script opens it read-only with `PRAGMA query_only = 1`, so an errant `INSERT`
fails at the driver instead of silently diverging.

The materializer is the same SQL surface the daemon serves to the SPA: column-typed rows, FTS5 indexes, normal joins. Query cost is `O(rows-returned)` rather than `O(history)`, so cron jobs do not pay the seconds-of-Y.Doc-replay tax that an in-process snapshot would cost.

For ranked search with snippets, use `openSqliteReader({ filePath })`; it wraps the
same database and exposes a `search()` helper. For typed Drizzle queries, pass the
returned `db` to `drizzle(db, { schema })` (the per-app schema lives in the app's
npm package).

## Writes: typed invoke through the daemon

`connectDaemonActions<TActions>({ mount, projectDir })` returns a typed proxy. `mount` is the mount name (`'fuji'` for the Fuji example); the proxy translates `fuji.entries_update({ ... })` into a `POST /run` over the daemon's Unix socket in the OS runtime directory. The daemon validates the input against the action's declared schema (invalid input comes back as a usage error), invokes the action in-process against the live Y.Doc, and returns a JSON `Result<T>`.

The mount name comes from each `Mount.name` in the `Mount[]` default-exported by `epicenter.config.ts`. App factories like `fuji()` return a mount whose name is `fuji`.

Two consequences fall out:

- **Strong read-after-write happens inside the action.** If a script wants the side effect to be visible to its next read, it should await the action result rather than reading SQLite again immediately. The action handler sees fresh in-memory state; the materializer is eventually consistent.
- **Type safety is opt-in.** `TActions` is the registry type the app's npm package exports (`FujiActions`, `HoneycrispActions`, etc.). The runtime never imports app code into the script process; only the type information flows across.

`projectDir` defaults to `findProjectRoot()`, which walks up from `process.cwd()` looking for `epicenter.config.ts`. Pass an explicit `projectDir` to opt out (cron jobs that run from `/` should).

## What if the daemon is not running?

Reads succeed: SQLite is just a file on disk, opening it does not require any running process.

Writes fail with `DaemonError.Required` because `connectDaemonActions` first does a health check against the socket and surfaces a clear error when no daemon is listening. There is no auto-spawn from the script process; explicit lifecycle is the contract. Start one with `epicenter daemon up` before running the script.

A script that only reads should not call `connectDaemonActions` at all. A script that only writes still needs the daemon up, but does not need to open SQLite. Compose the two when both are needed.
