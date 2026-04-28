# Script-first CLI collapse: promoting peer-wait to a workspace primitive

**Date:** 2026-04-28
**Status:** WIP / thinking-in-progress
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

1. **Move `waitForPeer` + `findPeer` + `explainEmpty` into `@epicenter/workspace`.** Co-locate with `attach-sync.ts` or its own module under `packages/workspace/src/document/`. Keep behavior identical. CLI re-imports.
2. **Promote `PeerMiss` into workspace** as a return type of `waitForPeer`. Update CLI's `RunError` to re-export or compose.
3. **Method-ify on `SyncAttachment`** (option A from move 1). `sync.waitForPeer(deviceId, { timeoutMs })`.
4. **Collapse the CLI renderer** in `run.ts` to the table-driven `formatRunError` shape.
5. **Document the duality** in a `docs/cli-vs-scripts.md` with side-by-side examples.

Step 1 is mechanical and unblocks everything. Steps 2-3 are typing decisions. Step 4 is the visible payoff. Step 5 cements the rule.

## Open questions

- **`PeerMiss.emptyReason` field shape.** Today it's `string | null` from `explainEmpty`. Worth typing as a discriminated union (`{ phase: 'connecting', lastError: ... } | { phase: 'disconnected' } | null`) so callers can format it themselves instead of relying on the pre-baked string? **Lean: structured.** If `offlineReason` stays CLI-private as a `sync.status` formatter, then the workspace `PeerMiss` shouldn't carry a pre-baked string — it should carry the relevant slice of `sync.status` (or a snapshot of it) and let the consumer format. Keeps workspace's surface honest and lets web UI render its own pill.
- **Should `peer<T>(sync, deviceId)` proxy gain a `wait` option?** Right now it calls `sync.find` at every invocation. A `peer<T>(sync, deviceId, { waitForResolve: 5000 })` variant could let scripts write `await proxy.foo.bar(input)` without manually waiting first. Nice ergonomics, but expands the proxy's surface. Defer.
- **`connectWorkspace` shipped state.** Spec `20260414T023253-connect-workspace.md` says it lives in `packages/cli/src/connect.ts`. Grep finds zero call sites in the actual code. Either it shipped under a different name or hasn't shipped yet. Worth confirming before script examples lean on it.
- **Test relocation.** `peer-wait.test.ts` lives in CLI; the `waitForPeer` portion follows the source into workspace, the rest stays.

## What this is NOT

- Not a rewrite of the daemon. Daemon process management stays in CLI. The unix-socket hop, the `getDaemon` helper, the `Required` / `MissingConfig` errors, all unchanged.
- Not removing the CLI. The CLI's job (shell I/O + daemon mgmt) is real; we're just stopping it from being the home for primitives that scripts also want.
- Not a perf optimization. Scripts will still pay cold-start cost (sync handshake, action graph load) that the daemon amortizes. The point is feature parity, not perf parity.
