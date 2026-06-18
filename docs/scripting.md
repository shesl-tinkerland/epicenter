# Scripting

A script is a Bun file that calls a running daemon's actions through `connectDaemonActions`. Both reads and writes default to actions: query actions return typed, strongly-consistent data; mutation actions are the only way to write. There is no `script.ts` recipe to copy. The daemon is the single writer; the script is a short-lived IPC client that holds no Y.Doc.

For bulk, analytical, FTS, or join-heavy reads, drop to the direct-file SQLite materializer (below): one `O(rows)` SQL scan beats N round-trips. That is the escape hatch, not the default. Actions per [ADR-0021](adr/0021-actions-are-the-only-surface-that-crosses-a-process-boundary.md) are the only surface that crosses the process boundary; the SQLite reader is a separate read-only view of the materialized file, not workspace access.

The Epicenter root is the folder that holds `epicenter.config.ts`. That config default-exports one `Mount`; one foreground daemon serves that mount over the root's Unix socket. The CLI addresses actions by their bare key (`epicenter run entries_update`): the daemon serves one mount, so the key alone is unambiguous, and the mount name is just the header `epicenter list` prints. Scripts likewise call actions by their bare keys through `connectDaemonActions`.

## The whole shape

```ts
import {
  connectDaemonActions,
  findEpicenterRoot,
  openWorkspaceSqlite,
} from "@epicenter/workspace/node";
import type { FujiActions } from "@epicenter/fuji";

// the Epicenter root is the folder that holds epicenter.config.ts
const epicenterRoot = findEpicenterRoot();

// reads: open the guid-keyed materializer read-only
const db = openWorkspaceSqlite(epicenterRoot, "epicenter-fuji");
const urgent = db
  .query(
    "SELECT * FROM entries WHERE EXISTS (SELECT 1 FROM json_each(entries.tags) WHERE value = ?)",
  )
  .all("urgent");

// writes: typed proxy over unix socket to the daemon
const fuji = await connectDaemonActions<FujiActions>({
  epicenterRoot,
});
for (const note of urgent) {
  await fuji.entries_update({ id: note.id, tags: ["triaged"] });
}

db.close();
```

That is the whole API. No machine auth in the script process, no encryption setup, no Y.Doc reconstruction, no WebSocket.

## Bulk reads: the SQLite materializer (escape hatch)

Default reads go through query actions (see Writes below: the same proxy serves
both). Reach for SQLite only when one scan beats many round-trips, or when you
need FTS, joins, or aggregates no action publishes.

Readers never have to go through actions: a read cannot diverge the source of
truth, so it needs no single-writer bottleneck (unlike writes). The choice is
purely consistency versus speed. A query action runs against the live in-memory
Y.Doc, so it is strongly consistent (read-after-write safe) at the cost of an
RPC. The SQLite materializer is a separate file the daemon refreshes after the
fact, so it is eventually consistent but pays no per-row round-trip. Pick the
action when you just wrote and need to see it; pick SQLite for bulk scans where
slight staleness is fine.

`openWorkspaceSqlite(epicenterRoot, workspaceId)` opens the guid-keyed
convention path `.epicenter/sqlite/<workspaceId>.db` read-only; first-party
mounts like Fuji write there. A mount that passed a custom `filePath` to its
materializer needs `openSqliteReader({ filePath })` with that same explicit
path. Neither helper inspects `epicenter.config.ts`. `.epicenter/` is generated
machine state, not a source layout or route registry. The daemon's `attachBunSqliteMaterializer` keeps that file fresh;
the script opens it read-only with `PRAGMA query_only = 1`, so an errant `INSERT`
fails at the driver instead of silently diverging.

The materializer is the same SQL surface the daemon serves to the SPA: column-typed rows, FTS5 indexes, normal joins. Query cost is `O(rows-returned)` rather than `O(history)`, so cron jobs do not pay the seconds-of-Y.Doc-replay tax that an in-process snapshot would cost.

For ranked search with snippets, use `openSqliteReader({ filePath })`; it wraps the
same database and exposes a `search()` helper. For typed Drizzle queries, pass the
returned `db` to `drizzle(db, { schema })` (the per-app schema lives in the app's
npm package).

## Writes: typed invoke through the daemon

`connectDaemonActions<TActions>({ epicenterRoot })` returns a typed proxy. The proxy translates `fuji.entries_update({ ... })` into a `POST /run` over the daemon's Unix socket in the OS runtime directory. The daemon validates the input against the action's declared schema (invalid input comes back as a usage error), invokes the action in-process against the live Y.Doc, and returns a JSON `Result<T>`.

The mount name comes from the single `Mount.name` default-exported by `epicenter.config.ts`. App factories like `fuji()` return a mount whose name is `fuji`; the CLI prints that label as the header for `epicenter list`.

Two consequences fall out:

- **Strong read-after-write happens inside the action.** If a script wants the side effect to be visible to its next read, it should await the action result rather than reading SQLite again immediately. The action handler sees fresh in-memory state; the materializer is eventually consistent.
- **Type safety is opt-in.** `TActions` is the app's action-registry type. The runtime never imports app code into the script process; only the type information flows across.

`epicenterRoot` is your Epicenter folder (the folder that holds `epicenter.config.ts`). It defaults to `findEpicenterRoot()`, which walks up from `process.cwd()` looking for that config. Pass an explicit `epicenterRoot` to opt out (cron jobs that run from `/` should).

## What if the daemon is not running?

Action calls (reads and writes both) fail with `DaemonError.Required`, because `connectDaemonActions` first does a health check against the socket and surfaces a clear error when no daemon is listening. There is no auto-spawn from the script process; explicit lifecycle is the contract. Start one with `epicenter daemon up` before running the script.

SQLite escape-hatch reads still succeed: the materializer is just a file on disk, and opening it read-only does not require any running process. So a script that does only bulk SQLite reads need not call `connectDaemonActions` at all; anything that calls an action (the default for both reads and writes) needs the daemon up. Compose the two when both are needed.
