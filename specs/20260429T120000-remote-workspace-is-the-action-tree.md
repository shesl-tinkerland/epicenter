# Remote workspace is the action tree

**Status**: proposal, not yet implemented
**Date**: 2026-04-29
**Author**: Braden, drafted with Claude
**Companion docs**:
- [`packages/workspace/docs/architecture/process-topology.md`](../packages/workspace/docs/architecture/process-topology.md): how processes reach a workspace; the precondition for caring about this spec.
- [`packages/workspace/docs/architecture/network-topology.md`](../packages/workspace/docs/architecture/network-topology.md): how Y.Doc owners converge.
- [`packages/workspace/docs/architecture/action-dispatch.md`](../packages/workspace/docs/architecture/action-dispatch.md): the third transport (cross-device peer RPC), which already uses the same action tree convention this spec generalizes.
- [`specs/20260429T004302-workspace-as-daemon-transport.md`](./20260429T004302-workspace-as-daemon-transport.md): the previous round, which built `RemoteWorkspace<W>` as a parallel contract. This spec walks that back.

---

## One sentence

A remote workspace is a typed proxy over the workspace itself, where the brand on `defineQuery`/`defineMutation` is the cut-line for what crosses the wire and the workspace's published type is the single source of truth.

## The vision, stated upfront

An author of a workspace publishes one function and one type:

```ts
// @apps/fuji
export function openFuji() {
  const ydoc = new Y.Doc({ guid: 'epicenter.fuji' });
  const tables = attachEncryption(ydoc).attachTables(ydoc, fujiTables);
  return {
    ydoc, tables, kv, encryption, batch, [Symbol.dispose]: () => {...},
    savedTabs: { create: defineMutation({...}) },
    // ... whatever else attaches
  };
}

export type Fuji = ReturnType<typeof openFuji>;
```

A remote consumer imports the type and passes it as the generic. Nothing else:

```ts
import type { Fuji } from '@apps/fuji';
import { connectDaemon } from '@epicenter/workspace';

const ws = await connectDaemon<Fuji>('fuji');

await ws.tables.entries.set(row);          // because tables.entries.set is branded
await ws.savedTabs.create({ url });        // because savedTabs.create is branded
// ws.ydoc                ← does not exist on the type
// ws.batch               ← does not exist on the type
// ws.encryption          ← does not exist on the type
// ws.tables.entries.filter   ← does not exist on the type
```

`connectDaemon` walks `Fuji` at the type level. Every leaf carrying the `defineQuery` or `defineMutation` brand becomes callable, awaited, and `Result`-wrapped. Everything else is filtered out by the brand check. There is no second contract anywhere in the system. The workspace's published type IS its remote contract, mechanically transformed.

## The skepticism this spec is responding to

While reviewing `packages/workspace/src/client/remote.ts` and `remote-workspace-types.ts`, the question came up: why is there a `RemoteWorkspace<W>` contract at all when `openFuji()` and friends have no contract? `openFuji` is structurally typed by its return value; nobody ever wrote `interface FujiWorkspace`. But the remote side has a hand-written nominal contract that pretends to mirror the local side, doesn't actually mirror it, and forces the team to maintain two parallel implementations of the same thing.

That asymmetry is the smell. This spec resolves it by deleting the parallel contract and deriving the remote shape from the same source the local shape already uses: the action tree, with `defineQuery` and `defineMutation` brands as the only thing that decides "is this on the wire."

## The smell, concretely

There are two contracts for the same workspace today:

```
Local (structural, no contract):                    Remote (nominal, hand-written):
─────────────────────────────────                   ────────────────────────────────
openFuji() returns whatever it returns.             RemoteWorkspace<W extends {tables;actions:Actions}> = {
  { tables, actions, kv, ydoc, idb, sync, ...}        tables: RemoteTablesOf<W['tables']>,
                                                       actions: RemoteActions<W['actions']>,
No interface. Pure duck typing. The                    sync: { peers() }            ← invented; unrelated to W['sync']
shape of the workspace is the result                 }
of attach* composition.
```

Three things go wrong:

1. **`tables` on the remote is a re-shape of CRUD already mounted as actions.** `buildTableActions(table, name)` mounts the six CRUD verbs as actions at `actions.tables.X.set` etc. `buildRemoteTables` then re-shapes those exact paths back into `tables.X.set(...)` so the proxy *looks like* the local `tables` slot. The six verbs are hardcoded in two files. The re-shape is pure cosmetic sugar, paid for by a parallel `RemoteTable` type, a `RemoteNotSupported` mechanism, and a separate proxy.
2. **`RemoteNotSupported` solves a problem we invented.** `filter` and `observe` are not actions. They are plain methods on the live `Table` type. They were never going to cross the wire because they take closures or are subscriptions. The throw-stubs only exist because we *promised* a `tables` namespace on the remote and then had to admit half its methods cannot cross. Drop the promise and the stubs have nothing to defend against.
3. **`sync.peers()` is daemon-scope masquerading as workspace-scope.** Locally, `sync` on a workspace is the `attachSync` handle (a long-lived subscription manager). Remotely, `sync` is `{ peers() }`, a daemon-wide listing that has no per-workspace meaning. The shared name is fake symmetry. `peers()` belongs on `DaemonClient`.

The deeper problem these symptoms share: **the remote side reaches into `W` for a fixed set of slots (`tables`, `actions`, then bolts on `sync`) instead of letting the workspace's own structure define the contract.**

## The reframe

Step back from the current implementation. What is the wire-callable substrate, really?

Every leaf on the wire must be JSON-in / JSON-out, addressable by a dotted path, and introspectable so a proxy can know what to call. The workspace already has exactly that thing: the action tree built from `defineQuery` and `defineMutation`. Both helpers brand their return value with metadata (input schema, title, description, kind). `walkActions` and `describeActions` in `packages/workspace/src/shared/actions.ts` traverse it at runtime.

So the wire substrate already exists. The mistake was building a *second* substrate (the `RemoteTable` typing path) parallel to it.

The reframe collapses that. The wire surface is whatever the action tree exposes. Nothing else has any business being on the wire. If you want something on the wire, wrap it in `defineQuery` or `defineMutation`. If you can't wrap it (closures, subscriptions, live Y.Doc), it isn't on the wire and there is no need to type-error or runtime-throw about it; the type simply does not include it.

## The workspace is the tree. There is no `actions` namespace.

The remote contract is `Remote<Fuji>`, not `Remote<Fuji['actions']>`. The `actions: { ... }` slot on the workspace bundle is removed entirely. Branded leaves sit at the top level of the workspace, alongside `tables` and `kv` (which themselves contain branded leaves at `tables.X.set`, `kv.Y.get`, etc.). The reasons:

1. **The local workspace already mixes branded actions with non-branded furniture in one object.** `openFuji()` returns `{ ydoc, tables, kv, encryption, batch, [Symbol.dispose], ... }`. There is no semantic boundary between `actions` and the rest at the top level; the boundary is the brand on each leaf. An `actions` namespace would be organizational ceremony, not a semantic line.
2. **The brand does the structural work.** "If you want `ws.foo` over the wire, define `foo` as `defineQuery` or `defineMutation`." That is the rule, stated honestly. An `actions` namespace would restate the rule with extra typing.
3. **`tables` and `kv` are already namespaced trees of leaves.** Once the CRUD methods on a `Table` are themselves `defineMutation`/`defineQuery` instances, the table is naturally a subtree of the workspace's action tree. There is no useful distinction between "actions the user wrote" and "actions the framework mounted." Both are just branded leaves.
4. **It matches in-process call shape.** Inside fuji, the developer writes `fuji.tables.entries.set(row)` and `fuji.savedTabs.create(input)`. Both are addressable from the workspace root locally. Both are addressable from the workspace root remotely. The shape is identical; only the call signature changes (sync vs `Promise<Result>`).

Locally the workspace includes things that cannot cross (Y.Doc, batch closure, idb, encryption, sync attachment). The remote mapped type filters them out by walking only branded leaves. So locally `fuji.ydoc` exists; remotely `ws.ydoc` does not exist on the type at all. That is the contract.

## The cut-line: brand presence

A leaf is on the wire if and only if it is the return value of `defineQuery` or `defineMutation`. Both helpers attach a brand the type system can see:

```ts
type Query<I, R>    = (input: I) => R | Promise<R>  & { __kind: 'query';    input: ... };
type Mutation<I, R> = (input: I) => R | Promise<R>  & { __kind: 'mutation'; input: ... };
```

Anything else, regardless of whether it happens to be a function, regardless of whether it returns JSON-friendly data, is not on the wire. Plain methods like `Table.filter`, `Table.observe`, `Table.batch`, getters, properties, Y.Doc handles, attach* handles all drop. This makes the rule type-checkable, not convention-checkable, and removes any need for runtime stubs.

**`attachTable` produces CRUD methods that are branded `defineQuery` / `defineMutation` instances directly.** Not "should." This is the rule. Same for `attachKv`. Branding the CRUD methods means they cross the wire automatically without a wrapper layer, deletes `buildTableActions` outright (the existing layer that re-wraps the same handlers as branded actions for the daemon side), and lets `tables.entries.set` be one function in both worlds. The non-branded methods on a `Table` (`filter`, `observe`, `find`, `count`, `has`) stay as plain methods and simply do not appear on the remote type.

## The type rule for the remote shape

The proxy walks the workspace and rewrites every branded leaf into a serializable, awaited, Result-typed call. The rule:

```
For each leaf in W:
  - if leaf is Query<I, R> or Mutation<I, R>:
      keep it; rewrite to (input: I) => Promise<Result<S, E | RpcError>>
        where S, E come from R:
          - if R is Result<S, E>: S = success, E = original error
          - else:                 S = R,       E = never
        and the wire error union `RpcError = DaemonError | ResolveError | RunError | TableParseError`
        folds into E.
  - if leaf is a non-branded function:        drop
  - if leaf is an object with branded descendants: recurse
  - if leaf is an object with no branded descendants: drop
  - otherwise (Y.Doc, primitives, getters):  drop
```

Concretely as a mapped type sketch (not the final form, but illustrative):

```ts
type RpcError = DaemonError | ResolveError | RunError | TableParseError;

type WireResult<R> =
  R extends Result<infer S, infer E>
    ? Result<S, E | RpcError>
    : Result<R, RpcError>;

type RemoteLeaf<F> =
  F extends Query<infer I, infer R>    ? (input: I) => Promise<WireResult<Awaited<R>>> :
  F extends Mutation<infer I, infer R> ? (input: I) => Promise<WireResult<Awaited<R>>> :
  never;

type Remote<T> = {
  [K in keyof T as
    T[K] extends Query<any, any> | Mutation<any, any> ? K :
    T[K] extends object ? (HasBrandedLeaves<T[K]> extends true ? K : never) :
    never
  ]: T[K] extends Query<any, any> | Mutation<any, any> ? RemoteLeaf<T[K]>
   : T[K] extends object ? Remote<T[K]>
   : never;
};
```

This is the user's stated rule precisely: **everything is awaited; everything is a Result; if it was already a Result, the error type is unioned with the wire error type.** The local handler can return either `R` or `Result<R, E>`; the remote signature flattens both into `Promise<Result<_, _ | RpcError>>` so call sites have a single shape.

## The developer's perspective

This is the part to optimize for. There are two seats: writing a workspace, and consuming one.

### Writing a workspace (mostly unchanged)

```ts
// apps/fuji/src/lib/fuji/index.ts (sketch)
import { attachEncryption, attachTables, attachKv, defineMutation } from '@epicenter/workspace';
import { type } from 'arktype';
import * as Y from 'yjs';
import { fujiTables } from '../workspace.js';

export function openFuji() {
  const ydoc = new Y.Doc({ guid: 'epicenter.fuji', gc: false });
  const encryption = attachEncryption(ydoc);
  const tables = encryption.attachTables(ydoc, fujiTables);    // CRUD methods are now branded
  const kv = encryption.attachKv(ydoc, {});

  // Custom user actions sit at the top level, alongside tables/kv. No `actions` slot.
  return {
    ydoc, encryption, kv, tables,
    batch: (fn: () => void) => ydoc.transact(fn),
    [Symbol.dispose]() { ydoc.destroy(); },

    // These are the things callable over the wire (plus tables.* and kv.* CRUD).
    savedTabs: {
      create: defineMutation({
        title: 'Create saved tab',
        input: type({ url: 'string' }),
        handler: ({ url }) => tables.savedTabs.set({ id: crypto.randomUUID(), url }),
      }),
    },
  };
}
```

Two things to notice:

- There is no `actions: { ... }` slot. The branded leaves are at top level. That is what becomes addressable on the wire.
- `tables.savedTabs.set` inside the handler is a plain in-process mutation against the live Table. The branding of `tables` CRUD is invisible to callers; you do not have to think about it.

### Consuming a workspace remotely (the part the user wanted detail on)

```ts
import { connectDaemon } from '@epicenter/workspace';
import type { openFuji } from '@apps/fuji';

// The generic IS the workspace shape. Not its `actions` slot. The whole thing.
const ws = await connectDaemon<ReturnType<typeof openFuji>>('fuji');
//          └── connects to the unix socket served by `epicenter serve`

// Branded leaves are reachable. Type system filters everything else.
await ws.savedTabs.create({ url: 'https://...' });
//       └── inferred: (input: { url: string }) => Promise<Result<void, TableParseError | RpcError>>

const result = await ws.tables.entries.getAllValid();
//                      └── inferred: () => Promise<Result<Entry[], RpcError>>

await ws.tables.entries.set({ id: 'abc', url: '...' });
// inferred: (input: Entry) => Promise<Result<void, TableParseError | RpcError>>

// These do NOT exist on the type and would be a compile error:
// ws.ydoc                    ← not on the wire (live Y.Doc)
// ws.batch(...)              ← not branded, not on the wire
// ws.tables.entries.filter(...)   ← not branded
// ws.tables.entries.observe(...)  ← not branded
// ws.kv.someUnboundKey       ← not branded if your kv has only typed entries
```

The mental model collapses to: **the type of `ws` is the workspace, with everything that isn't a defined action stripped out, and every remaining leaf wrapped as `Promise<Result<_, _ | RpcError>>`.**

For day-to-day use, that is one rule, not three.

### Daemon-scope calls (peers, list) are separate

```ts
// `connectDaemon` returns a workspace handle. For daemon-wide calls,
// hold onto the underlying client.
import { openDaemon } from '@epicenter/workspace';

const daemon = await openDaemon();           // the IPC client itself
const peers = await daemon.peers();          // daemon-wide
const workspaces = await daemon.list();
const fuji = daemon.workspace<ReturnType<typeof openFuji>>('fuji');  // workspace-scoped proxy
await fuji.savedTabs.create({ url });
```

This split lifts `peers()` out of the fake `sync` slot on the workspace facade and puts it where it belongs: on the daemon. The workspace handle is purely the action tree.

## What collapses

Going through the code, file by file:

| File | Action |
|---|---|
| `packages/workspace/src/client/remote-workspace-types.ts` | Replace `RemoteWorkspace<W>`, `RemoteTablesOf`, `RemoteTable`, `RemoteCallError` with one `Remote<T>` mapped type. |
| `packages/workspace/src/client/remote-not-supported.ts` | Delete. The cut-line is in the type, no runtime stub needed. |
| `packages/workspace/src/client/remote.ts` | Delete `buildRemoteTables`. Keep the recursive action proxy (it already implements walk-and-dispatch); rename it. Drop the hardcoded `sync.peers` slot from the facade. |
| `packages/workspace/src/client/connect-daemon.ts` | Generic param changes from `<W extends {tables;actions:Actions}>` to `<W>`; return type is `Remote<W>`. Add or expose `daemon.peers()` / `daemon.list()` separately. |
| `packages/workspace/src/daemon/table-actions.ts` | Delete. The six verbs are defined inside `attachTable` as branded leaves; there is no wrapper layer. |
| `packages/workspace/src/document/attach-table.ts` | The CRUD methods (`get`, `getAllValid`, `set`, `update`, `delete`, `bulkSet`) are constructed as `defineMutation` / `defineQuery` instances. Plain methods (`filter`, `observe`, `find`, `count`, `has`) stay as-is and simply drop on the remote. |
| `packages/workspace/src/daemon/run-handler.ts` | Action path resolution is unchanged; `tables.X.verb` is just a path through the workspace tree like any other. Delete special-casing if any. |
| `apps/fuji/src/lib/fuji/index.ts` | Migration: move `actions: { ... }` contents up to the top level. The `actions` slot is removed. |
| `playground/opensidian-e2e/epicenter.config.ts` | Same migration as fuji. |
| `apps/tab-manager/...`, future apps | Same migration. |

The total LOC delta is negative. The `client/` directory shrinks to two files (proxy + connect). The daemon-side keeps its routing untouched: the wire still receives a dotted action path, the daemon still resolves it against the workspace tree, the only change is that the tree no longer has a fixed `actions.` prefix.

## Migration

One PR. Hard cut.

- Branded leaves move out of `actions: { ... }` to the top level of every workspace bundle.
- `attachTable` and `attachKv` produce branded CRUD directly; `buildTableActions` is deleted.
- `RemoteWorkspace<W>`, `RemoteTablesOf`, `RemoteTable`, `RemoteCallError`, and `RemoteNotSupported` are deleted; `Remote<T>` is the only exported mapped type.
- `connectDaemon<W>` accepts the full workspace type as `W`. Existing call sites passing `<W>` continue to compile as long as `W` is still the workspace type; the remote shape they get back is now derived by the new mapped type.
- `peers()` moves off the workspace facade onto the daemon client. CLI/script call sites updating from `ws.sync.peers()` to `daemon.peers()` is a find/replace.

The known consumers are fuji, tab-manager, and the opensidian playground. All live in this monorepo. There are no external consumers to migrate; a soft-alias or compatibility-shim phase is unnecessary.

## Decided questions

These were open in earlier drafts. They are decisions now, not options.

1. **`attachTable` CRUD is branded.** `attachTable` returns an object whose `get`, `getAllValid`, `set`, `update`, `delete`, `bulkSet` are `defineMutation` / `defineQuery` instances. The handlers are synchronous and return `Result<_, _>`. The `Mutation` / `Query` brand carries metadata; it does not force the call to be async. In-process call sites continue to use the sync `Result<TRow, E>` branch with no ergonomic change. The remote mapped type wraps every branded leaf in `Promise<Result<_, _ | RpcError>>` regardless of the handler's local sync/async nature; that is consistent and unambiguous on the wire.
2. **`Remote<W>` walks the full workspace.** Not scoped to a known slot. `walkActions` is replaced by a generic `walkBrandedLeaves(value)` that recurses any object and yields branded leaves with their dotted paths. Cheap; workspaces are small.
3. **`Y.Doc` and other class instances drop cleanly via brand-only inclusion.** The mapped type only includes leaves whose type matches `Query<I, R> | Mutation<I, R>` or objects whose recursive `Remote<...>` is non-empty. `Y.Doc` is neither; it drops without a nominal exclusion list.
4. **Sync attachment surface is local-only.** `sync.observe`, `sync.onStatusChange`, `sync.whenConnected` are not branded and drop from the remote type. If a script needs sync status, the daemon exposes it as a top-level call (`daemon.syncStatus(workspaceName)`), not nested under the workspace.
5. **`Symbol.dispose` drops.** `connectDaemon`'s returned object owns its own disposal that closes the IPC connection. Calling `[Symbol.dispose]` does not forward to the remote workspace.
6. **Type-hover ergonomics.** The exported `Remote<T>` is wrapped in a `Simplify` helper so IDE hover output shows the flattened call shape rather than a wall of conditional types. This is a small style choice, not a functional one.

## Why this is worth doing

Three reasons, in order of weight:

1. **One contract, derived from the source.** The local workspace shape, filtered by brand, IS the remote contract. No parallel implementation. New attach primitives, new actions, new namespaces propagate to the remote automatically.
2. **The cut-line is type-checkable.** "Wrap in `defineQuery`/`defineMutation` to expose, otherwise it stays local" is a rule the type system enforces. No `RemoteNotSupported` runtime trap, no maintenance debt for dynamic property stubs, no convention drift.
3. **The developer perspective is honest.** The local workspace is structural. The remote workspace is the same shape, mechanically transformed. The transformation rule is one mapped type that can be read in fifteen lines. Anyone who can read `openFuji` can read its remote contract.

The current code has good instincts buried under a layer that thought it was helping. This spec lifts the layer.
