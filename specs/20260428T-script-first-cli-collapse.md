# Script-first CLI collapse: promoting peer-wait to a workspace primitive

**Date:** 2026-04-28
**Status:** Steps 1-4 landed; steps 5-6 pending
**Author:** AI-assisted (Braden + Claude)
**Branch:** `post-pr-1705-cleanup-v1`

## One-sentence thesis

`@epicenter/workspace` is the product; the CLI is a thin shell wrapper, so any logic that a `bun script.ts` consumer would also want (peer waiting, empty-state explanation) belongs in the workspace package, not in CLI-private utility modules.

## Why this matters

Today the CLI's `peer-wait.ts`, `explainEmpty`, and `loadConfig` are CLI-private but read only public `SyncAttachment` surface. Anyone writing a script against `@epicenter/workspace` who wants to dispatch to a remote peer has to reimplement the awareness-observe loop, the deadline budget, and the "why is no one connected" diagnostic. That's an unforced duplication: the CLI is just one consumer of these primitives, and treating it as the only consumer puts script users on a worse path than CLI users for no good reason.

The end state we want:

```
                 ┌──────────────────────────────────┐
                 │    @epicenter/workspace          │
                 │                                  │
                 │  loadWorkspace, invokeAction,    │
                 │  resolveActionPath, walkActions, │
                 │  describeActions, sync.peers,    │
                 │  sync.observe, sync.rpc,         │
                 │  sync.waitForPeer    (NEW)       │
                 │  sync.explainEmpty   (NEW)       │
                 │  PeerMiss error type (NEW)       │
                 └────────────┬─────────────────────┘
                              │
              ┌───────────────┴────────────────┐
              │                                │
       ┌──────┴───────┐               ┌────────┴─────────┐
       │  bun script  │               │  epicenter CLI   │
       │  (1st class) │               │  (shell sugar +  │
       │              │               │   daemon mgmt)   │
       └──────────────┘               └──────────────────┘
```

Two consumers, one library. CLI's distinctive value shrinks to: process lifecycle (`up`/`down`/`ps`/`logs`), auth bootstrap, and shell I/O (stdin parsing, exit codes, `--format`).

## Inventory: what's where today

| Concern              | Location today                    | Public to scripts? | Should be     |
|----------------------|-----------------------------------|--------------------|---------------|
| `invokeAction`       | `packages/workspace`              | yes                | yes           |
| `resolveActionPath`  | `packages/workspace`              | yes                | yes           |
| `walkActions`        | `packages/workspace`              | yes                | yes           |
| `describeActions`    | `packages/workspace`              | yes                | yes           |
| `sync.peers()`       | `packages/workspace` (attach-sync)| yes                | yes           |
| `sync.find()`        | `packages/workspace` (attach-sync)| yes                | yes (already) |
| `sync.observe()`     | `packages/workspace` (attach-sync)| yes                | yes           |
| `sync.rpc()`         | `packages/workspace` (attach-sync)| yes                | yes           |
| `peer<T>` proxy      | `packages/workspace` (rpc/peer)   | yes                | yes           |
| `waitForPeer`        | `packages/cli/util/peer-wait.ts`  | **no**             | promote as `sync.waitForPeer` |
| `findPeer`           | `packages/cli/util/peer-wait.ts`  | **no**             | **delete** (`sync.find` already exists) |
| `PeerHit` type       | `packages/cli/util/peer-wait.ts`  | **no**             | **delete** (`FoundPeer` already exists) |
| `PeerMiss` error     | `packages/cli/daemon/run-errors`  | **no**             | promote        |
| `explainEmpty`       | `packages/cli/util/peer-wait.ts`  | **no**             | stay CLI-private (rename `offlineReason`); formats `sync.status` |
| `loadConfig`         | `packages/cli/load-config.ts`     | **no**             | stay CLI-private (filesystem convention) |
| Auth session store   | `packages/cli/auth/*`             | **no**             | deferred       |

### Discovery from this round

`sync.find(deviceId)` already exists on `SyncAttachment` (`packages/workspace/src/document/attach-sync.ts:177, 930-941`) and does exactly what CLI's `findPeer` does: sorted by `clientId` asc, exact match on `state.device.id`. CLI's `findPeer` and `PeerHit` are dead duplication and get deleted, not promoted.

Net new in workspace: **one method** (`sync.waitForPeer`) and **one error** (`PeerMiss`).

## API shape decision: methods on `SyncAttachment`, no hybrid

Earlier draft proposed a hybrid (`sync.findPeer` as method, `waitForPeer` as standalone helper). That was a smell: two patterns for the same kind of thing forces every consumer to learn both.

`SyncAttachment` already exposes `peers()`, `find()`, `observe()`, `rpc()` as methods. `waitForPeer` is the same kind of thing (peer-aware operation that depends on awareness state), so it's a method too:

```ts
ws.sync.waitForPeer(deviceId, { timeoutMs: 5000 })
  : Promise<Result<FoundPeer, PeerMiss>>
```

One pattern. Consistent with the existing surface. Discoverable next to `sync.find`.

`PeerMiss` is exported as a standalone error type from `@epicenter/workspace` (parallel to `RpcError`).

## Package boundary: workspace vs sync

We have two candidate packages: `@epicenter/sync` and `@epicenter/workspace`.

- `@epicenter/sync` is the **wire protocol layer**: WebSocket frames, auth subprotocol, origin parsing, RPC error wire shape. It does not know about awareness, peers, or `SyncAttachment`. Look at `packages/sync/src/index.ts`: `protocol.ts`, `rpc-errors.ts`, `auth-subprotocol.ts`, `origins.ts`. No `peers()`, no `observe()`.
- `@epicenter/workspace` owns `SyncAttachment` (`packages/workspace/src/document/attach-sync.ts`), which is where `peers()`, `observe()`, `rpc()`, and `status` live.

**Decision:** `waitForPeer` and `explainEmpty` go in `@epicenter/workspace`, attached to or co-located with `SyncAttachment`. They depend on awareness state, which is a workspace-level concept, not a wire-protocol concept. `@epicenter/sync` stays low-level.

## What each move does, concretely

### Move 1: `sync.waitForPeer(deviceId, options) -> Result<FoundPeer, PeerMiss>`

**What it is.** A method on `SyncAttachment` that subscribes to awareness via `sync.observe()`, resolves on first match found via `sync.find()`, and bails on deadline. Today's implementation in `peer-wait.ts:70-105` is already correct and uses only public surface; this is a relocation, not a rewrite.

**Shape:**

```ts
sync.waitForPeer(deviceId: string, options: { timeoutMs: number })
  : Promise<Result<FoundPeer, PeerMiss>>
```

Method, not standalone helper. See "API shape decision" section above.

**What changes for callers:**

```ts
// before (CLI-private, scripts can't do this cleanly)
import { waitForPeer, explainEmpty } from '../util/peer-wait.js'
const { hit, sawPeers } = await waitForPeer(workspace, deviceId, deadline)
if (!hit) {
  return RunError.PeerMiss({
    peerTarget: deviceId,
    sawPeers,
    workspace: ctx.workspace,
    waitMs: ctx.waitMs,
    emptyReason: explainEmpty(workspace),
  })
}

// after, in CLI's run-handler
const result = await ws.sync.waitForPeer(deviceId, { timeoutMs: ctx.waitMs })
if (result.error) return result   // PeerMiss is already a workspace error

// after, in a bun script
const ws = await connectWorkspace(createFujiWorkspace)
const result = await ws.sync.waitForPeer('device-mac', { timeoutMs: 5000 })
if (result.error) {
  console.error('peer miss:', result.error.peerTarget)
  process.exit(3)
}
const { clientId, state } = result.data
```

`connectWorkspace` awaits `whenReady` internally per `specs/20260414T023253-connect-workspace.md`, so script examples don't need `await ws.whenReady`. The CLI side gets shorter (no manual deadline math, no manual `PeerMiss` construction); the script side becomes possible at all.

### Move 2: `PeerMiss` becomes a workspace error type

Today `PeerMiss` is a variant of `RunError` in `packages/cli/src/daemon/run-errors.ts`. After move 1, it's the failure case of `sync.waitForPeer`, so it belongs in workspace, alongside `RpcError`.

Fields stay the same shape:

```ts
PeerMiss: {
  peerTarget: string         // deviceId asked for
  sawPeers: boolean          // any peers visible during wait
  waitMs: number             // budget consumed
  emptyReason: string | null // explainEmpty result, captured at miss time
}
```

CLI's `RunError` keeps its other variants (`UsageError`, `RuntimeError`) and re-imports `PeerMiss` from workspace. The CLI renderer still narrows on `error.name === 'PeerMiss'` exactly as it does today.

### Move 3: collapse the CLI renderer

After moves 1+2, the renderer in `packages/cli/src/commands/run.ts:123-177` collapses because most error variants are now workspace-typed and the CLI just maps each name to (lines, exit code).

```ts
// after
function renderRunResult(result, format) {
  if (!result.error) return output(result.data, { format })
  const { lines, exitCode } = formatRunError(result.error)
  for (const line of lines) outputError(line)
  process.exitCode = exitCode
}
```

The big switch becomes a table:

```ts
const exitCodeFor: Record<RunError['name'] | DaemonError['name'], 1 | 2 | 3> = {
  UsageError: 1, RuntimeError: 2,
  PeerMiss: 3, RpcError: 2,
  UnknownWorkspace: 1, AmbiguousWorkspace: 1,
  MissingConfig: 1, Required: 1,
  Timeout: 1, Unreachable: 1, HandlerCrashed: 1,
}
```

Compile-time exhaustiveness via `satisfies` catches drift the moment a new variant is added.

### Move 4 (deferred): `loadWorkspace` for scripts

Open question. Today `loadConfig` walks up directories looking for `epicenter.config.ts`, picks a workspace by name from a multi-config, and connects it. A script user has two paths:

1. **Direct import.** `import config from './epicenter.config.ts'; const ws = await connectWorkspace(config.default)`. Works, but the user has to know the import shape.
2. **Promote `loadWorkspace`.** Public helper that does config discovery + workspace selection. Lower friction for scripts, but it grows the workspace package's surface and pulls in filesystem-walking logic.

**Lean: defer.** Script users who want config discovery can import the CLI's helper today; if a real script use case shows up that needs it, promote then. Scripts that know their workspace can use the direct import. Don't grow workspace surface speculatively.

## What stays CLI-only, forever

- `up` / `down` / `ps` / `logs`: process management. Owns unix socket, metadata files, pid lifecycle, log files. No workspace primitive will replace these because they're about the daemon process itself.
- `auth`: pre-workspace session bootstrap. Could be promoted to a `@epicenter/auth-cli` library if multiple consumers emerge, but no signal yet.
- Shell I/O around `run` / `list` / `peers`: stdin parsing, `@file.json` convention, `--format json/jsonl`, exit-code mapping. These are TTY concerns; scripts handle them differently.
- The daemon hop itself (the unix-socket IPC). Scripts pay startup cost on each invocation; the daemon amortizes it. That's the CLI's *actual* product value, not the action surface.

## Order of operations

Independent steps, each shippable on its own:

1. ~~**Move `waitForPeer` + `findPeer` + `explainEmpty` into `@epicenter/workspace`.**~~ Done. `findPeer` was dead duplication of `sync.find` and got deleted; `explainEmpty` became a private `describeOfflineReason` inside `attach-sync.ts`. Commits: `feat(workspace): add sync.waitForPeer + PeerMiss`, `refactor(cli): use sync.waitForPeer; delete peer-wait helpers`.
2. ~~**Promote `PeerMiss` into workspace** as a return type of `waitForPeer`.~~ Done. CLI's `RunError` no longer carries a `PeerMiss` variant; `RunResponse` composes `RunError | PeerMiss | ResolveError`.
3. ~~**Method-ify on `SyncAttachment`**.~~ Done. `sync.waitForPeer(deviceId, { timeoutMs })` ships.
4. ~~**Collapse the CLI renderer** in `run.ts` to the table-driven shape.~~ Done. `EXIT_CODE` table with `satisfies Record<ErrorName, 1 | 2 | 3>` makes drift a compile error; pure `formatPeerMiss` / `formatRpcError` functions return `string[]` and are testable without `console.error` spies.
5. **Daemon-optional `list`.** Pending. `list` only needs `walkActions` / `describeActions` (no sync). Add `getWorkspaceOrLoad(target)`: try the daemon first, fall back to inline `loadConfig`. `peers` and `run --peer` stay daemon-required (they need a warm sync room).
6. **Document the duality** in a `docs/cli-vs-scripts.md` with side-by-side examples. Pending.

Steps 1-4 landed in the script-first-cli-collapse PR series. Steps 5-6 are the natural follow-up.

## Future moves (deferred)

These are the "where could this go" options, not commitments. Each is shippable on its own when the trigger condition arrives.

### Option B: daemon as a service

**Today**: daemon code lives in `packages/cli/src/daemon/`, intermingled with CLI commands. The CLI is the only consumer.

**Move**: extract `@epicenter/daemon` (server + client). The unix-socket protocol becomes a documented public contract. CLI imports `connectDaemon` from there; future consumers (Tauri sidecar, web tunnel, mobile bridge) can too.

**Call site after** (CLI side, near-identical):

```ts
// packages/cli/src/commands/run.ts
import { connectDaemon } from '@epicenter/daemon/client'

const daemon = await connectDaemon(target)
const result = await daemon.run({ actionPath, input, peerTarget, waitMs })
```

**Call site after** (new consumer):

```ts
// apps/whispering/src-tauri/sidecar.ts (hypothetical)
import { connectDaemon } from '@epicenter/daemon/client'
const daemon = await connectDaemon({ socketPath: epicenterSocketPath() })
const peers = await daemon.peers()  // power a "who's online" indicator in the desktop UI
```

**Trigger**: a second consumer materializes. Most likely: a Tauri sidecar in `apps/whispering` or `apps/tab-manager` that wants to read peer presence without spawning `epicenter` as a subprocess.

**Cost**: 2-3 days. File moves, package boilerplate, doc the IPC protocol. No behavior change.

**Why defer**: with one consumer, the package boundary is correct architecture without a payoff. The CLI's `daemon/` folder being internal-shaped doesn't hurt anyone today.

### Option C: generated CLI

**Today**: every action is invoked through `epicenter run <dot.path> [json blob]`. JSON input is opaque; no per-action `--help`; no shell completion for action names.

**Move**: derive yargs subcommands from `walkActions(workspace.actions)` at startup. Each `defineQuery` / `defineMutation` becomes a first-class `epicenter <path>` subcommand with typed flags from the action's input schema.

**User experience after**:

```bash
$ epicenter savedTabs.create --url "https://..." --title "..."
$ epicenter sync.status
$ epicenter --peer device-mac savedTabs.create --url "..."

$ epicenter savedTabs.create --help
Usage: epicenter savedTabs.create [options]
  Add a saved tab to the workspace.
Options:
  --url <string>      (required)
  --title <string>    (required)
  --pinned <boolean>  (optional, default: false)

$ epicenter savedT<TAB>           # tab completion
```

**Implementation sketch**:

```ts
// cli.ts after option C
const ws = await getWorkspaceOrExit(target)  // need workspace to know its actions
const cli = yargs(argv).scriptName('epicenter')

// hand-authored: process management, auth, the tree-listing verb
cli.command(authCommand)
   .command(upCommand).command(downCommand).command(psCommand).command(logsCommand)
   .command(listCommand)

// generated: one yargs subcommand per action in the workspace
for (const [path, action] of walkActions(ws.actions ?? {})) {
  cli.command(generateActionCommand(path, action))
}

await cli.parse()
```

**Trigger**: the action surface grows past ~20 entries and shell usage is frequent enough that JSON-blob ergonomics actively annoy users.

**Cost**: 1-2 weeks (real work). Schema introspection, schema → flag mapping, completion files, graceful `--help` when no workspace is loadable.

**Downsides** (the "is it worth it" answer):

1. **Schema-to-flags is lossy.** Primitives map cleanly. Nested objects, discriminated unions, recursive schemas, user-defined arktype constructs: not so much. The fallback is `--field '<json>'`, which is what we have today, just hidden one level deeper. For non-trivial inputs the gain over `epicenter run path '<json>'` evaporates.

2. **Error messages get messier.** Yargs validates flags, then arktype validates the resulting input. Two error sources, two error formats, sometimes the same value flagged by both. "Missing required argument: url" (yargs) vs "Expected string, got number at .url" (arktype) needs reconciliation, or you get duplicated errors.

3. **`--help` becomes config-dependent.** Today `epicenter --help` works without any workspace. After option C, you need to load the workspace to know what subcommands exist. If the config is broken, `--help` shows a load error instead of help. Bootstrapping mess.

4. **Tab completion has per-shell tax.** Bash, zsh, fish each need their own completion script. Each has different completion semantics and limitations. Maintaining three is real ongoing cost; shipping one means partial coverage.

5. **Action authors implicitly design CLI surfaces.** Today action authors structure inputs however they want; the CLI just ships JSON. After option C, "I want a discriminated union here" becomes "you have to pick CLI-friendly field names." API design pollutes through into shell ergonomics. Workspace authors who don't care about CLI now have to.

6. **Versioning gets coupled.** Workspace lib version vs CLI version vs action schema version. Today the CLI just sends JSON: workspace bumps don't need CLI bumps. After option C, the CLI introspects the schema, so a workspace lib bump that adds a new schema construct may need a matching CLI bump.

7. **Discovery problem.** Where does the workspace come from? `epicenter.config.ts` in CWD? In `--dir`? What if multiple workspaces? `--workspace` is a chicken-and-egg with subcommand resolution: you need to resolve the workspace to know what subcommands exist, but `--workspace` is itself a CLI flag that needs parsing first.

8. **Loses simplicity as a mental model.** Today: "epicenter run is RPC over a unix socket." After option C: "epicenter is a generated CLI from a TypeScript schema, with daemon transport." More magic, more failure modes, more support burden.

9. **Scripts already solve this.** A user who wants typed CLI args for their actions can write a 30-line script using their own argv parsing. The win for built-in generation is centralized; the cost is in the framework. With small action surfaces, the script is the right tool.

**Honest verdict**: Option C is exciting but has diminishing returns. For 5 actions, JSON blobs are fine. For 50 actions across many users, generation pays. Today we're closer to "fine." If pursued, do it after Options 1+2 land — the schema introspection is more tractable when the daemon already speaks a typed protocol.

### What this rules out

By the same "script-first" principle, these are NOT future moves:

- Adding `--repeat`, `--all-peers`, `--if-then` flags to `run`. Those are scripting concerns; live in user scripts. The CLI's `--peer` + `--wait` is the ceiling.
- Auto-printing action results in a "smart" format (table, tree, etc). `--format json/jsonl` is already the truthy interchange. Smart printing is a script-level decision.
- Caching daemon responses in the CLI. The daemon's response is already amortized; another cache layer is misplaced.

## Open questions

- **`PeerMiss.emptyReason` field shape.** Today it's `string | null` from `explainEmpty`. Worth typing as a discriminated union (`{ phase: 'connecting', lastError: ... } | { phase: 'disconnected' } | null`) so callers can format it themselves instead of relying on the pre-baked string? **Lean: structured.** If `offlineReason` stays CLI-private as a `sync.status` formatter, then the workspace `PeerMiss` shouldn't carry a pre-baked string — it should carry the relevant slice of `sync.status` (or a snapshot of it) and let the consumer format. Keeps workspace's surface honest and lets web UI render its own pill.
- **Should `peer<T>(sync, deviceId)` proxy gain a `wait` option?** Right now it calls `sync.find` at every invocation. A `peer<T>(sync, deviceId, { waitForResolve: 5000 })` variant could let scripts write `await proxy.foo.bar(input)` without manually waiting first. Nice ergonomics, but expands the proxy's surface. Defer.
- **`connectWorkspace` shipped state.** Spec `20260414T023253-connect-workspace.md` says it lives in `packages/cli/src/connect.ts`. Grep finds zero call sites in the actual code. Either it shipped under a different name or hasn't shipped yet. Worth confirming before script examples lean on it.
- **Test relocation.** `peer-wait.test.ts` lives in CLI; the `waitForPeer` portion follows the source into workspace, the rest stays.

## What this is NOT

- Not a rewrite of the daemon. Daemon process management stays in CLI. The unix-socket hop, the `getDaemon` helper, the `Required` / `MissingConfig` errors, all unchanged.
- Not removing the CLI. The CLI's job (shell I/O + daemon mgmt) is real; we're just stopping it from being the home for primitives that scripts also want.
- Not a perf optimization. Scripts will still pay cold-start cost (sync handshake, action graph load) that the daemon amortizes. The point is feature parity, not perf parity.
