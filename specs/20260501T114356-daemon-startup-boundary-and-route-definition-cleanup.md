# Daemon Startup Boundary And Route Definition Cleanup

**Date**: 2026-05-01
**Status**: Superseded
**Author**: AI-assisted
**Branch**: codex/explicit-daemon-host-config
**Superseded by**: `20260520T120000-code-composed-daemon-route-map.md`

> Historical note: this spec's array route shape is not current. Current code
> rejects route arrays and accepts `defineConfig({ daemon: { routes: { ... } } })`
> for multi-route projects. The usual single-project shape is
> `defineWorkspace({ open })`.

## One-Sentence Test

`epicenter up` claims the project daemon slot before importing config, then starts package-defined daemon route definitions behind that owned local socket.

## Overview

This spec tightens the daemon config and startup path while moving daemon routes to an array of route definitions. The breaking change is a cleaner type vocabulary, async runtime disposal, package-owned default route names, and a startup flow that separates config parsing from route startup so daemon ownership is claimed before side effects begin.

## Motivation

### Current State

The active public daemon types are still a route map of bare callback functions:

```ts
export type DaemonRouteContext = {
	projectDir: ProjectDir;
	route: string;
};

export type DaemonRuntime = {
	[Symbol.dispose](): void;
	readonly actions: Actions;
	readonly sync: SyncAttachment;
	readonly peerDirectory: PeerDirectory;
	readonly rpc: SyncRpcAttachment;
};

export type DaemonRouteDefinition<TRuntime extends DaemonRuntime = DaemonRuntime> =
	(options: DaemonRouteContext) => MaybePromise<TRuntime>;

export type EpicenterConfig<
	TRoutes extends Record<string, DaemonRouteDefinition> = Record<
		string,
		DaemonRouteDefinition
	>,
> = {
	daemon: {
		routes: TRoutes;
	};
};
```

The normal config shape is:

```ts
export default defineConfig({
	daemon: {
		routes: {
			fuji: defineFujiDaemon(),
		},
	},
});
```

`loadConfig()` imports the config, validates the route map, calls every route callback, shape-checks each runtime, and returns started runtimes:

```txt
runUp
  -> loadConfig(projectDir)
       -> import epicenter.config.ts
       -> call route callbacks
       -> return [{ route, runtime }]
  -> createDaemonServer({ projectDir, runtimes })
  -> listen()
```

This creates problems:

1. **Startup side effects happen before ownership**: A second `epicenter up` can import config and start live route definitions before `listen()` discovers an existing daemon.
2. **The names are stale**: `DaemonRouteDefinition` is a factory, `DaemonRouteContext` is daemon route context, and `StartedDaemonRoute` is a started route entry.
3. **Disposal is split across layers**: The loader calls `[Symbol.dispose]()` and separately awaits `runtime.sync.whenDisposed`. The runtime should own that teardown contract.
4. **The server contract is false**: `createDaemonServer().listen()` says repeat calls are a no-op, but a second call can hit the socket it created and return `AlreadyRunning`.
5. **Route validation is not shared**: `loadConfig()` validates route keys, but the exported server path only checks duplicate routes.
6. **Default route drift is easy**: `defineFujiDaemon()` is mounted under a map key, while `connectFujiDaemonActions()` defaults to `DEFAULT_FUJI_DAEMON_ROUTE`. The common path should not require users or agents to repeat that string correctly.

### Desired State

The config authoring shape stays small:

```ts
import { defineConfig } from '@epicenter/workspace/daemon';
import { defineFujiDaemon } from '@epicenter/fuji/daemon';

export default defineConfig({
	daemon: {
		routes: [defineFujiDaemon()],
	},
});
```

No `title` or `workspaceId` belongs on daemon route definitions. The route definition owns only the local mount name and the startup hook. Workspace identity belongs to the Y.Doc. Human labels belong on actions or future UI-specific metadata, not on this transport contract.

The runtime types should read like the system works:

```ts
export type DaemonRouteContext = {
	projectDir: ProjectDir;
	route: string;
};

export type DaemonRuntime = {
	readonly actions: Actions;
	readonly sync: SyncAttachment;
	readonly peerDirectory: PeerDirectory;
	readonly rpc: SyncRpcAttachment;
	[Symbol.asyncDispose](): MaybePromise<void>;
};

export type DaemonRouteDefinition<
	TRuntime extends DaemonRuntime = DaemonRuntime,
> = {
	route: string;
	start(context: DaemonRouteContext): MaybePromise<TRuntime>;
};

export type EpicenterConfig = {
	daemon: {
		routes: readonly DaemonRouteDefinition[];
	};
};

export type StartedDaemonRoute = {
	route: string;
	runtime: DaemonRuntime;
};
```

## Research Findings

### Active Type Surface

The active code has already removed route metadata. `title` and `workspaceId` do not exist in `packages/workspace/src/daemon/types.ts`. The route map currently owns routing identity, but app daemon packages also export default route constants used by script connectors.

**Key finding**: Reintroducing descriptive metadata would reverse the current direction, but moving the route string into a route definition solves a real drift problem.

**Implication**: Use public route definition objects with only `{ route, start }`. Do not add `title`, `description`, or `workspaceId`.

### Default Route Drift

Fuji shows the tension:

```ts
export const DEFAULT_FUJI_DAEMON_ROUTE = 'fuji';

export function defineFujiDaemon() {
	return ({ projectDir }: DaemonRouteContext) => {
		// start Fuji runtime
	};
}

export function connectFujiDaemonActions({
	route = DEFAULT_FUJI_DAEMON_ROUTE,
	projectDir,
} = {}) {
	return connectDaemonActions({ route, projectDir });
}
```

The current config has to repeat the route as a map key:

```ts
export default defineConfig({
	daemon: {
		routes: {
			fuji: defineFujiDaemon(),
		},
	},
});
```

That means an app package owns the default route for scripts, while the config owns the actual route for daemon startup. An AI or a human writing a script far away from `epicenter.config.ts` will usually use `connectFujiDaemonActions()` with its default. If the config mounted Fuji under another string without making that custom route visible in the script, the script points at the wrong daemon path.

**Key finding**: Requiring every script to pass a route is too strict. It pushes local mount knowledge onto the least informed caller.

**Implication**: App packages should own default routes for the common case. Configs should compose route definitions, and custom route mounts should be explicit overrides.

```ts
export default defineConfig({
	daemon: {
		routes: [defineFujiDaemon()],
	},
});

const fuji = await connectFujiDaemonActions();
```

Custom route names still work, but both sides name the custom mount:

```ts
export default defineConfig({
	daemon: {
		routes: [defineFujiDaemon({ route: 'blog' })],
	},
});

const blog = await connectFujiDaemonActions({ route: 'blog' });
```

### Async Construction Pattern

The workspace attachment layer uses synchronous construction with async readiness properties:

```ts
const sqlite = attachSqlite(ydoc, { filePath })
	.table(tables.entries);

await sqlite.whenLoaded;
```

This is deliberate. `attachSqlite().table(...)`, `attachSync().attachPresence(...)`, `attachSync().attachRpc(...)`, and UI workspace exports all need a synchronously available object. Making these constructors async would make table registration, Svelte render gates, and module exports worse.

**Key finding**: The async boundary should move at daemon route startup, not at every attachment primitive.

**Implication**: Route `start()` hooks may be async. Attach primitives should remain sync and expose `whenLoaded`, `whenConnected`, `whenReady`, and `whenDisposed` where those signals are meaningful.

### Daemon Ownership

`bindOrRecover()` uses socket ping to distinguish live daemons from stale socket files. That works for stale recovery, but it is too late in the current flow because route callbacks have already started.

The better ownership gate is a startup socket that answers `/ping` before config import and route startup. After routes start, the same server mounts the real daemon app.

```txt
runUp
  -> resolve real project dir
  -> verify config file exists
  -> create daemon server with startup app
  -> listen, which claims the socket
  -> write metadata
  -> import and validate config
  -> start route definitions
  -> mount real route app
```

**Key finding**: Claiming the local socket before config import protects even configs with top-level side effects.

**Implication**: `createDaemonServer` should no longer require started runtimes at construction time.

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Config shape | `daemon.routes` array | App packages can provide default route definitions, and configs compose them like integrations. |
| Top-level helper | Rename `defineConfig` to `defineConfig` | The import path already says Epicenter daemon config. The shorter name matches ecosystem convention. |
| App route helper | Rename `fujiDaemon()` style helpers to `defineFujiDaemon()` | These helpers return route definitions. They do not open resources until `start()` runs. |
| App action connector | Rename `openFujiDaemonActions()` style helpers to `connectFujiDaemonActions()` | These helpers talk to an already-running daemon. `connect` matches `connectDaemonActions` and avoids implying local resource construction. |
| Route entries | `{ route, start }` definitions | This makes the package default route the common source of truth without adding descriptive metadata. |
| Route metadata | Do not add `title` or `workspaceId` | Route names are local addresses. Y.Doc guid owns workspace identity. Action metadata owns labels. |
| Duplicate routes | Loader error | Arrays allow duplicates, so `loadDaemonConfig()` must reject them before startup. |
| Runtime disposal | Use `[Symbol.asyncDispose]` | The runtime should own teardown and await its own attachment barriers. |
| Config loading | Split parse from start | `runUp` must claim ownership before import and before factory side effects. |
| Attach primitives | Keep sync construction and readiness promises | This preserves builder chains, module exports, and UI render gates. |
| Sync connection | Do not await `sync.whenConnected` in daemon startup | `epicenter up` must work offline and report status later. |
| Local readiness | Route `start()` hooks may await local persistence only when needed | Awaiting SQLite or file materializer readiness is app-specific. The daemon framework should not impose it. |
| Server startup | Listen with a startup app, then mount routes | The socket becomes the ownership gate before route startup. |

### Naming Audit

| Current name | Target name | Reason |
| --- | --- | --- |
| `defineConfig` | `defineConfig` | The import path already says Epicenter. This matches Vite, Astro, and Nitro style config helpers. |
| `DaemonRouteContext` | `DaemonRouteContext` | The object is passed to one daemon route starter. It is not the whole config context. |
| `DaemonRouteDefinition` | `DaemonRouteDefinition` | The value is a route entry object, not a loaded module. |
| `StartedDaemonRoute` | `StartedDaemonRoute` | The value is a started route plus its runtime. The name should say it is after startup. |
| `fujiDaemon()` | `defineFujiDaemon()` | The helper returns a route definition and delays side effects until `start()`. |
| `openFujiDaemonActions()` | `connectFujiDaemonActions()` | The helper connects to an existing daemon over IPC. It does not open the Fuji workspace locally. |
| `FUJI_DAEMON_ROUTE` | `DEFAULT_FUJI_DAEMON_ROUTE` | The constant is the package default, not necessarily the mounted route in every config. |

Names that should stay:

- `DaemonRuntime`: this is the actual runtime contract after a route starts.
- `DaemonServer`: the object owns a socket listener and lifecycle methods.
- `loadDaemonConfig()`: the function imports and validates config without starting routes.
- `startDaemonRoutes()`: the function calls route `start()` hooks and owns cleanup on partial failure.
- `mountRoutes()`: the server already exists, and this installs the served route table.

## Architecture

### Before

```txt
+------------------+
| runUp            |
+------------------+
        |
        v
+------------------+
| loadConfig       |
| import config    |
| start routes     |
+------------------+
        |
        v
+------------------+
| create server    |
| bind socket      |
+------------------+
```

The daemon slot is claimed after route side effects have already happened.

### After

```txt
+----------------------+
| runUp                |
| realpath project dir |
+----------------------+
          |
          v
+----------------------+
| create daemon server |
| startup app only     |
+----------------------+
          |
          v
+----------------------+
| listen               |
| socket is claimed    |
+----------------------+
          |
          v
+----------------------+
| loadDaemonConfig     |
| import and validate  |
+----------------------+
          |
          v
+----------------------+
| startDaemonRoutes    |
| call start hooks     |
+----------------------+
          |
          v
+----------------------+
| mountRoutes          |
| /peers /list /run    |
+----------------------+
```

The server starts with enough app surface for `/ping`. Once routes are ready, it swaps to the real daemon app.

### Suggested Server Shape

```ts
export type DaemonServer = {
	readonly socketPath: string;
	listen(): Promise<Result<UnixSocketServer, StartupError>>;
	mountRoutes(routes: StartedDaemonRoute[]): void;
	close(): Promise<void>;
};

export function createDaemonServer({
	projectDir,
	triggerShutdown,
}: {
	projectDir: ProjectDir;
	triggerShutdown?: () => void;
}): DaemonServer;
```

Implementation can use a mutable fetch delegate instead of relying on `server.reload()`:

```ts
let currentFetch = buildStartingDaemonApp().fetch;

const app = {
	fetch(request: Request, env: unknown, executionCtx: unknown) {
		return currentFetch(request, env, executionCtx);
	},
};

return {
	mountRoutes(routes) {
		currentFetch = buildDaemonApp(routes, triggerShutdown).fetch;
	},
};
```

## Target API

### Public Daemon Types

```ts
export type DaemonRouteContext = {
	projectDir: ProjectDir;
	route: string;
};

export type DaemonRuntime = {
	readonly actions: Actions;
	readonly sync: SyncAttachment;
	readonly peerDirectory: PeerDirectory;
	readonly rpc: SyncRpcAttachment;
	[Symbol.asyncDispose](): MaybePromise<void>;
};

export type DaemonRouteDefinition<
	TRuntime extends DaemonRuntime = DaemonRuntime,
> = {
	route: string;
	start(context: DaemonRouteContext): MaybePromise<TRuntime>;
};

export type EpicenterConfig = {
	daemon: {
		routes: readonly DaemonRouteDefinition[];
	};
};

export function defineConfig(config: EpicenterConfig): EpicenterConfig {
	return config;
}
```

### Internal Loader Types

```ts
export type LoadedDaemonConfig = {
	projectDir: ProjectDir;
	configPath: string;
	routes: readonly DaemonRouteDefinition[];
};

export type StartedDaemonRoute = {
	route: string;
	runtime: DaemonRuntime;
};
```

### Loader Flow

```ts
export async function loadDaemonConfig(
	projectDir: ProjectDir,
): Promise<Result<LoadedDaemonConfig, DaemonConfigError>>;

export async function startDaemonRoutes(
	config: LoadedDaemonConfig,
): Promise<Result<StartedDaemonRoute[], DaemonConfigError>>;
```

`loadDaemonConfig()` imports and validates. `startDaemonRoutes()` calls `start()` hooks and disposes already-started routes if a later route fails.

### Route Definition Example

```ts
export const DEFAULT_FUJI_DAEMON_ROUTE = 'fuji';

export function defineFujiDaemon({
	route = DEFAULT_FUJI_DAEMON_ROUTE,
	...options
}: FujiDaemonOptions = {}): DaemonRouteDefinition {
	return {
		route,
		async start({ projectDir }) {
			const doc = openFujiDoc({ clientID: hashClientId(projectDir) });
			const sync = attachSync(doc, syncOptions(options));
			const awareness = attachAwareness(doc.ydoc, {
				schema: { peer: PeerIdentity },
				initial: { peer: peerFromOptions(options) },
			});
			const peerDirectory = createPeerDirectory({ awareness, sync });
			const rpc = sync.attachRpc(doc.actions);

			const sqlite = attachSqlite(doc.ydoc, {
				filePath: sqlitePath(projectDir, doc.ydoc.guid),
			}).table(doc.tables.entries);

			await sqlite.whenLoaded;

			return {
				actions: doc.actions,
				sync,
				peerDirectory,
				rpc,
				async [Symbol.asyncDispose]() {
					doc[Symbol.dispose]();
					await sync.whenDisposed;
				},
			};
		},
	};
}
```

This awaits local SQLite because Fuji daemon actions may depend on the local mirror. It does not await `sync.whenConnected`.

## Implementation Plan

### Phase 1: Rename And Reshape The Public Type Surface

- [x] **1.1** Rename `DaemonRouteContext` to `DaemonRouteContext`.
- [x] **1.2** Replace `DaemonRouteDefinition` with `DaemonRouteDefinition`.
- [x] **1.3** Rename `StartedDaemonRoute` to `StartedDaemonRoute`.
- [x] **1.4** Rename `defineConfig` to `defineConfig`.
- [x] **1.5** Change `EpicenterConfig.daemon.routes` from a record to `readonly DaemonRouteDefinition[]`.
- [x] **1.6** Update every app, example, playground, test fixture, and README import.
- [x] **1.7** Do not add `title` or `workspaceId` to daemon route types.
- [x] **1.8** Rename app daemon route helpers from `fujiDaemon()` style to `defineFujiDaemon()` style.
- [x] **1.9** Add a `route` option to app daemon route helpers with package-owned defaults, for example `defineFujiDaemon({ route = DEFAULT_FUJI_DAEMON_ROUTE })`.
- [x] **1.10** Rename app route constants from `FUJI_DAEMON_ROUTE` style to `DEFAULT_FUJI_DAEMON_ROUTE` style so the name does not imply it is always the mounted route.
- [x] **1.11** Rename app daemon action helpers from `openFujiDaemonActions()` style to `connectFujiDaemonActions()` style.

### Phase 2: Make Runtime Disposal Async

- [x] **2.1** Change `DaemonRuntime` from `[Symbol.dispose](): void` to `[Symbol.asyncDispose](): MaybePromise<void>`.
- [x] **2.2** Update route definitions to await their own teardown barriers inside `[Symbol.asyncDispose]`.
- [x] **2.3** Replace loader-level `runtime[Symbol.dispose]()` plus `runtime.sync.whenDisposed` with `await runtime[Symbol.asyncDispose]()`.
- [x] **2.4** Use `Promise.allSettled` or equivalent cleanup handling so cleanup failures do not mask the original startup error.

### Phase 3: Split Config Parse From Route Startup

- [x] **3.1** Replace `loadConfig()` with `loadDaemonConfig()` and `startDaemonRoutes()`.
- [x] **3.2** Make `loadDaemonConfig()` validate shape, route names, and duplicate routes without calling `start()`.
- [x] **3.3** Make `startDaemonRoutes()` call `start()` sequentially and dispose the successful prefix on failure.
- [x] **3.4** Rename error variants from module language to definition language, for example `InvalidRouteDefinition`.

### Phase 4: Claim The Daemon Slot Before Config Import

- [x] **4.1** Change `createDaemonServer()` so it can listen before routes exist.
- [x] **4.2** Serve a startup app that answers `/ping` and returns a typed not-ready response for route endpoints.
- [x] **4.3** Add `mountRoutes(routes)` to install the real Hono app after route startup.
- [x] **4.4** Make `listen()` idempotent. Repeated calls on the same handle return the existing server result.
- [x] **4.5** Make `runUp()` order: realpath project dir, check config file, listen, write metadata, load config, start routes, mount routes.
- [x] **4.6** Make `runUp().teardown()` call `daemonServer.close()` instead of duplicating stop and socket cleanup.

### Phase 5: Share Validation And Harden Tests

- [x] **5.1** Move route key validation to a shared daemon helper used by both loader and server mounting.
- [x] **5.2** Validate route names from embedded callers before mounting routes.
- [x] **5.3** Add a test that a second `runUp()` does not import config or call route `start()` hooks when the startup socket is already claimed.
- [x] **5.4** Add a test for top-level config side effects: the side effect should not run if another daemon owns the socket.
- [x] **5.5** Update daemon fakes so tests satisfy the real `presence.waitForPeer` and `rpc.rpc` contract.
- [x] **5.6** Add a test for idempotent `listen()`.

### Phase 6: Documentation And Migration

- [x] **6.1** Update CLI README examples from `defineConfig` to `defineConfig`.
- [x] **6.2** Update specs that refer to `DaemonRouteDefinition`, `StartedDaemonRoute`, or `DaemonRouteContext`.
- [x] **6.3** Document that daemon startup never waits for `sync.whenConnected`.
- [x] **6.4** Document when route definitions should await local readiness promises.

## Edge Cases

### Missing Config

1. `epicenter up -C <dir>` resolves the project dir.
2. No `epicenter.config.ts` exists.
3. `runUp()` returns `MissingFile` without claiming a socket.

### Existing Live Daemon

1. `epicenter up` creates the startup socket.
2. A second `epicenter up` starts.
3. The second process pings the socket and returns `AlreadyRunning` before importing config.

### Route Startup Failure

1. The daemon slot is claimed and metadata is written.
2. A route `start()` hook throws.
3. Started routes are async-disposed, metadata is removed, the server closes, and the original route error is returned.

### Offline Sync

1. A route `start()` hook creates `attachSync()`.
2. The network is unavailable.
3. The daemon still starts, `sync.status` reports connecting or offline, and `sync.whenConnected` is not awaited by the framework.

### Local Materializer Readiness

1. A route action depends on a local SQLite mirror.
2. The route `start()` hook creates the materializer.
3. The route `start()` hook awaits `materializer.whenLoaded` before returning the runtime.

## Open Questions

1. **Should `defineEpicenterConfig` remain as a temporary alias?**
   - Options: remove it in the breaking change, keep it as a deprecated alias, or keep both forever.
   - Recommendation: remove it in this breaking change. The point is to clean the public vocabulary.

2. **Should startup route endpoints return `Starting` or HTTP 503 before routes mount?**
   - Options: return typed `DaemonError.Starting`, return HTTP 503, or expose only `/ping`.
   - Recommendation: expose `/ping` and return HTTP 503 for route endpoints until mounted. Client commands should almost never see this because `runUp()` mounts routes before returning.

3. **Should `bindUnixSocket()` become sync?**
   - Context: `Bun.serve()` and chmod are synchronous today, while `bindOrRecover()` is async because it pings.
   - Recommendation: leave this optional. The startup ordering matters more than the return type of this helper.

4. **Should route definitions await local materializers by default?**
   - Options: framework awaits nothing, each app awaits its own local readiness, or the runtime exposes a required `whenReady`.
   - Recommendation: each app decides. A required `whenReady` would recreate the same split lifecycle problem under a different name.

## Success Criteria

- [x] `epicenter up` claims the daemon socket before importing `epicenter.config.ts`.
- [x] A second `epicenter up` against a live daemon does not import config and does not start route definitions.
- [x] Public daemon types use `DaemonRouteContext`, `DaemonRouteDefinition`, `StartedDaemonRoute`, and `defineConfig`.
- [x] Public daemon route types do not include `title` or `workspaceId`.
- [x] `DaemonRuntime` owns async teardown through `[Symbol.asyncDispose]`.
- [x] `createDaemonServer().listen()` is idempotent.
- [x] Route validation is shared by loader and embedded server callers.
- [x] Existing browser and attachment `whenReady` or `whenLoaded` patterns remain synchronous construction with async readiness properties.
- [x] Targeted tests pass with `bun test packages/cli/src/load-config.test.ts packages/cli/src/commands/up.test.ts packages/workspace/src/daemon/*.test.ts`.
- [ ] Full typecheck passes with the repo's standard Bun command.

## References

- `packages/workspace/src/daemon/types.ts`: public daemon type surface to rename and tighten.
- `packages/cli/src/load-config.ts`: current combined parse and start path.
- `packages/cli/src/commands/up.ts`: daemon process orchestration and metadata lifecycle.
- `packages/workspace/src/daemon/server.ts`: server factory that should claim before routes exist.
- `packages/workspace/src/daemon/unix-socket.ts`: socket binding and stale socket recovery.
- `packages/workspace/src/daemon/app.ts`: pure daemon route app, should stay pure.
- `packages/workspace/src/document/attach-sync.ts`: sync construction and `whenConnected` semantics.
- `packages/workspace/src/document/attach-sqlite.ts`: sync builder with `whenLoaded` readiness.
- `apps/fuji/src/lib/fuji/daemon.ts`: representative app daemon route definition.
- `examples/notes-cross-peer/notes.ts`: example runtime currently exposes extra fields and `whenReady`.

## Review

**Completed**: 2026-05-01
**Branch**: codex/explicit-daemon-host-config

### Summary

Implemented the breaking daemon config cleanup. Public daemon config now uses `defineConfig({ daemon: { routes: [...] } })`, app route helpers return `{ route, start }` definitions, and app daemon action helpers use `connect*DaemonActions` names.

Daemon startup now claims the Unix socket before importing config. `runUp()` verifies the config file exists, starts a startup server, writes metadata, then imports config, starts route definitions, and mounts the real route app.

### Deviations From Spec

- No temporary `defineEpicenterConfig` alias was added.
- Full `bun typecheck` still fails in unrelated Svelte packages. The first failing run now reports existing `apps/zhongwen`, `packages/svelte-utils`, and `packages/ui` diagnostics such as unresolved `#/utils.js` aliases, missing `@tanstack/ai-svelte`, and stale `from-table.svelte.ts` result-shape assumptions.

### Follow-up Work

- Clean up historical daemon planning specs that still describe older `hosts` terminology if those documents should be treated as live reference material instead of implementation history.
