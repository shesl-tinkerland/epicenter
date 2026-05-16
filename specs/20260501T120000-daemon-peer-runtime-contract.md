# Daemon Peer Runtime Contract

**Date**: 2026-05-01
**Status**: Superseded
**Author**: AI-assisted
**Branch**: `codex/explicit-daemon-host-config`

**Superseded By**: `20260501T114356-daemon-startup-boundary-and-route-definition-cleanup.md` and `20260501T180000-awareness-source-of-truth.md`

This spec records the invariant that daemon runtimes are real peer runtimes,
not optional action bags. The active API keeps that invariant but uses the newer
names: `DaemonRouteDefinition`, `DaemonRuntime`, `StartedDaemonRoute`,
`peerDirectory`, and `[Symbol.asyncDispose]`.

**Do Not Implement These Names Or Examples**: Code examples below are historical
context for an older `hosts` and `defineDaemon` design. The active daemon
runtime contract is:

```ts
export type DaemonRuntime = {
	readonly actions: Actions;
	readonly sync: SyncAttachment;
	readonly peerDirectory: PeerDirectory;
	readonly rpc: SyncRpcAttachment;
	[Symbol.asyncDispose](): MaybePromise<void>;
};
```

Use the superseding startup-boundary and awareness-source specs for active API
shape.

## Historical One-Sentence Test

A daemon is a route-addressed workspace peer that the CLI can introspect, keep online, observe through presence, and invoke through actions locally or over RPC.

That sentence is the line. If a surface helps with route addressing, introspection, online lifecycle, presence, local action invocation, or peer RPC, it belongs in the daemon contract. If a surface only opens a document, materializes files, or exposes local helper functions, it belongs below the daemon contract.

## Historical Overview

This historical spec proposed tightening `DaemonWorkspace` from "a disposable
action host with optional peer attachments" into "a started workspace peer with
required actions, sync, presence, and RPC." It also separated words that were
being used too loosely: a daemon definition was static manifest metadata plus a
delayed start function; a daemon workspace was the live peer runtime returned
after start; a plain action host was a smaller concept and should not pretend to
be a daemon.

The goal is not to add ceremony. The goal is to make the API say what the CLI already assumes.

## Motivation

### Current State

The public config shape now makes the route a single source of truth at definition time:

```ts
export default defineConfig({
	hosts: [
		defineDaemon({
			route: 'notes',
			title: 'Notes',
			workspaceId: 'epicenter.notes-repro',
			start: () => ({
				...notes,
				actions,
				sync,
				presence,
				rpc,
			}),
		}),
	],
});
```

That is the right direction. `route` is no longer returned from the started workspace, so the runtime object does not have to repeat the same routing metadata.

The runtime type still carries an older idea:

```ts
export type DaemonWorkspace = {
	[Symbol.dispose](): void;
	readonly actions: Actions;
	readonly sync?: SyncAttachment;
	readonly presence?: PeerPresenceAttachment;
	readonly rpc?: SyncRpcAttachment;
};
```

This creates a mixed signal. The word "daemon" sounds like a peer process, and `epicenter up` presents it as a long-lived online workspace. But the type says a daemon may be action-only, may not be present in awareness, may not have an RPC channel, and may not expose sync status.

The call sites show the split:

```ts
// packages/workspace/src/daemon/app.ts
const peers = entry.workspace.presence?.peers() ?? new Map();
```

```ts
// packages/workspace/src/daemon/run-handler.ts
if (!presence || !rpc) {
	return RunError.UsageError({
		message: `Workspace "${entry.route}" has no peer RPC attachment; --peer requires presence and RPC.`,
	});
}
```

```ts
// packages/cli/src/commands/up.ts
const presence = entry.workspace.presence;
if (!presence) return;

const sync = entry.workspace.sync;
if (!sync) return;
```

Those guards are defensive, but they also hide the real invariant. `epicenter up` is not very meaningful for a workspace that cannot report sync status, cannot show peers, and cannot route peer RPC.

This creates problems:

1. **The runtime contract is weaker than the CLI contract**: `DaemonWorkspace` permits hosts that the daemon can start but cannot fully operate. The code then spreads optional chaining across the daemon server and CLI commands.
2. **Failure moves too late**: A host without `rpc` compiles, loads, starts, appears in `list`, and only fails when a user runs with `--peer`.
3. **Tests encode the wrong shape**: Fake daemon workspaces can omit the peer surfaces unless each test happens to need them. That means the tests are not documenting the real minimum daemon contract.
4. **The word "daemon" gets diluted**: If a daemon can be a local action bag, a sync peer, or a document opener, then `defineDaemon` is carrying too many meanings.
5. **Optional fields invite accidental product design**: Every caller has to decide what a missing `presence` or missing `rpc` means. That should be a type-level answer, not a local interpretation at every call site.

### Superseded Desired State

`defineDaemon` should define a daemon host: static metadata plus a way to start a full peer runtime.

```ts
export type DaemonWorkspace = {
	[Symbol.dispose](): void;
	readonly actions: Actions;
	readonly sync: SyncAttachment;
	readonly presence: PeerPresenceAttachment;
	readonly rpc: SyncRpcAttachment;
};
```

A daemon with no meaningful remote commands still has RPC. Its action tree can be empty:

```ts
start: ({ projectDir }) => {
	const doc = openZhongwenDoc({ clientID: hashClientId(projectDir) });
	const sync = attachSync(doc, {
		url: websocketUrl(`${apiUrl}/workspaces/${doc.ydoc.guid}`),
		getToken,
		webSocketImpl,
	});
	const presence = sync.attachPresence({ peer });
	const actions = {};
	const rpc = sync.attachRpc(actions);

	return {
		...doc,
		yjsLog,
		sync,
		presence,
		rpc,
		actions,
	};
}
```

That may look redundant at first. It is not. The empty action tree says "this daemon has no remote actions today." The RPC attachment says "this daemon is still a peer in the daemon network and the peer invocation mechanism is installed." Those are different facts.

If we later need a local-only action bag, it should get a different name:

```ts
defineLocalActionHost({
	route: 'notes',
	title: 'Notes',
	actions,
});
```

That API does not exist today. The spec does not propose adding it until a real caller needs it. The important design rule is that we should not use `defineDaemon` for that smaller thing.

## Historical Definitions

### Daemon Host Definition

A `DaemonHostDefinition` is config-time metadata plus a delayed runtime factory.

```ts
type DaemonHostDefinition<TWorkspace extends DaemonWorkspace> = {
	route: string;
	title?: string;
	description?: string;
	workspaceId?: string;
	start(options: DaemonRouteContext): MaybePromise<TWorkspace>;
};
```

It is introspectable before startup. That matters because the config loader, CLI, and future UI surfaces can show "what hosts does this project declare?" without opening documents, creating Yjs state, touching disk, or connecting to a server.

It owns:

| Field | Why it is static |
| --- | --- |
| `route` | The daemon server uses it to route `/list`, `/run`, and `/peers`. It must be known before the workspace starts. |
| `title` | Human-facing label for CLI or UI surfaces. It should not require opening the workspace. |
| `description` | Human-facing explanation. Same reason as `title`. |
| `workspaceId` | Stable identity metadata for discovery and future validation. It is not runtime storage. |
| `start` | The boundary where local resources, sync, presence, RPC, and actions become live. |

It should not own:

| Field | Why not |
| --- | --- |
| `actions` | Actions often close over a started document, materializers, sync, or services. |
| `sync` | Sync is a live attachment, not manifest metadata. |
| `presence` | Presence belongs to a connected peer. |
| `rpc` | RPC is attached to the live sync transport and action root. |
| `route` inside the returned workspace | The route already lives in the definition. Repeating it creates drift. |

### Daemon Workspace

A `DaemonWorkspace` is the runtime object returned from `start`. It is what the daemon server can actually operate.

```ts
type DaemonWorkspace = {
	[Symbol.dispose](): void;
	actions: Actions;
	sync: SyncAttachment;
	presence: PeerPresenceAttachment;
	rpc: SyncRpcAttachment;
};
```

It owns:

| Field | Why it belongs here |
| --- | --- |
| `[Symbol.dispose]` | The daemon starts resources and must tear them down. |
| `actions` | The CLI introspects and invokes these actions locally. |
| `sync` | The daemon is expected to bring a workspace online and report transport status. |
| `presence` | The daemon is expected to know which peers are online and targetable. |
| `rpc` | The daemon is expected to invoke target peers through the same action tree. |

It may contain extra app-specific fields through generic inference, but daemon code should ignore them:

```ts
const host = defineFujiDaemon();
const workspace = await host.start(ctx);

workspace.yjsLog; // app-specific, allowed by the concrete inferred type
workspace.sync; // daemon contract
```

This is why the generic `DaemonHostDefinition<TWorkspace>` matters. We can keep app-specific return precision without adding an index signature to `DaemonWorkspace`.

### Hosted Daemon Workspace

A `HostedDaemonWorkspace` is the daemon server's routed wrapper:

```ts
type HostedDaemonWorkspace = {
	route: string;
	workspace: DaemonWorkspace;
};
```

The entry is the place where static routing metadata and the live runtime meet. The route does not move deeper into `workspace` because the workspace is not the router. The daemon server is the router.

### Local Action Host

A local action host would be a separate concept if we need it:

```ts
type LocalActionHost = {
	route: string;
	title?: string;
	actions: Actions;
};
```

This is intentionally not a daemon. It cannot show peers, cannot participate in sync, cannot be targeted over RPC, and does not need a long-lived process contract. If we add it later, it should make those limits obvious in the name and command behavior.

## Research Findings

### Actual CLI Usage

The current daemon CLI already treats sync, presence, and RPC as a bundle in behavior, even though the type marks them optional.

| Surface | Uses actions | Uses sync | Uses presence | Uses RPC |
| --- | --- | --- | --- | --- |
| `epicenter list` | Yes | No | No | No |
| `epicenter run <route.path>` | Yes | No | No | No |
| `epicenter run --peer <peer>` | Yes | No directly | Yes | Yes |
| `epicenter peers` | No | No | Yes | No |
| `epicenter up` status logs | No | Yes | Yes | No |
| teardown | No | Yes, via `whenDisposed` if present | Indirect | Indirect |

Key finding: not every command uses every field, but the daemon product surface assumes all of them are available. Optional fields are implementation leakage from the transitional type, not a product feature.

Implication: making these required simplifies daemon code and gives better failures. A bad daemon shape should fail when authored or loaded, not when a user happens to call a peer-only command.

### Current App Daemons

The official app daemons mostly already satisfy the stricter contract.

| App | Sync | Presence | RPC | Actions | Notes |
| --- | --- | --- | --- | --- | --- |
| Fuji | Yes | Yes | Yes | Yes | Already shaped like a peer daemon. |
| Honeycrisp | Yes | Yes | Yes | Yes | Already shaped like a peer daemon. |
| Opensidian | Yes | Yes | Yes | Empty | Peer daemon with no public actions today. |
| Zhongwen | Yes | Yes | No | Empty | Needs `sync.attachRpc(actions)` to satisfy the peer contract. |

Key finding: the stricter daemon contract is not a broad app rewrite. It mostly codifies what the main app daemons already do.

Implication: the migration cost is concentrated in tests, playground configs, documentation examples, and Zhongwen.

### Playgrounds and Inline Configs

Some configs use `defineDaemon` as a convenient way to get a route and actions into the CLI, not as a full peer runtime. Examples include playground e2e configs and README snippets.

This is the useful pressure test. Either those configs should become real daemon peers, or we should introduce a smaller API for local-only action hosting. Keeping `defineDaemon` loose so those examples keep compiling would preserve the smell we are trying to remove.

Key finding: these callers are not a reason to keep `DaemonWorkspace` weak. They are the evidence that we have been using one API name for two different concepts.

Implication: decide whether each caller is a daemon or a local action host. Do not split the difference inside `DaemonWorkspace`.

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| What is a daemon? | A route-addressed workspace peer | The CLI command set is built around online lifecycle, peer discovery, and action invocation. |
| Where does `route` live? | Only on `DaemonHostDefinition` and `HostedDaemonWorkspace` | Route is routing metadata. The started workspace should not repeat it. |
| Are `actions` required? | Yes | `list` and local `run` are core daemon behaviors. Empty actions are allowed. |
| Is `sync` required? | Yes | `up` means "bring this route online." A daemon without sync is just an action host. |
| Is `presence` required? | Yes | Peer discovery is part of the daemon surface. Silent absence makes `peers` misleading. |
| Is `rpc` required? | Yes | Remote action invocation is part of the daemon surface. Missing RPC should not be a runtime surprise. |
| Should storage be standardized now? | No | Storage is app-specific. A daemon must expose peer runtime surfaces, but it does not need one storage backend. |
| Should `sync`, `presence`, and `rpc` become `transport: { ... }` now? | Defer | A bundle may be cleaner later, but requiring the existing top-level fields is the smaller migration. |
| Should we add `defineLocalActionHost` now? | Defer | Add it only when a real caller needs local-only actions after the daemon contract is strict. |
| Should `workspaceId` be validated against the sync document id? | Defer | The field is static metadata today. Validation is useful later, but it is not required to settle the daemon contract. |

## Architecture

The intended shape has three layers:

```text
epicenter.config.ts
  |
  | defineConfig({ hosts })
  v
DaemonHostDefinition
  route: string
  title?: string
  description?: string
  workspaceId?: string
  start(ctx): DaemonWorkspace
  |
  | loadConfig starts host
  v
HostedDaemonWorkspace
  route: string
  workspace: DaemonWorkspace
  |
  | buildDaemonApp routes IPC requests
  v
DaemonWorkspace
  actions: Actions
  sync: SyncAttachment
  presence: PeerPresenceAttachment
  rpc: SyncRpcAttachment
  dispose(): void
```

The separation is deliberate:

```text
Static manifest:
  route, title, description, workspaceId

Runtime peer:
  actions, sync, presence, rpc, disposal

Server routing wrapper:
  route + runtime peer
```

This gives us one source of truth for the route while still letting the server route requests after startup.

## Proposed API Shape

### Strict Daemon Runtime

```ts
export type DaemonWorkspace = {
	[Symbol.dispose](): void;
	readonly actions: Actions;
	readonly sync: SyncAttachment;
	readonly presence: PeerPresenceAttachment;
	readonly rpc: SyncRpcAttachment;
};
```

### Daemon Definition

```ts
export type DaemonHostDefinition<
	TWorkspace extends DaemonWorkspace = DaemonWorkspace,
> = {
	[EPICENTER_DAEMON_HOST]: true;
	route: string;
	title?: string;
	description?: string;
	workspaceId?: string;
	start(options: DaemonRouteContext): MaybePromise<TWorkspace>;
};
```

### App-Level Helper

App helpers should keep the public call site small:

```ts
export function defineFujiDaemon({
	route = DEFAULT_FUJI_DAEMON_ROUTE,
	apiUrl = EPICENTER_API_URL,
	getToken = createCredentialTokenGetter({ serverOrigin: apiUrl }),
	peer = defaultFujiDaemonPeer(),
	webSocketImpl,
}: DefineFujiDaemonOptions = {}) {
	return defineDaemon({
		route,
		title: 'Fuji',
		description: 'Fuji daemon workspace',
		workspaceId: FUJI_WORKSPACE_ID,
		start: ({ projectDir }) => {
			const fuji = openFuji({ clientID: hashClientId(projectDir) });
			const actions = createFujiActions(fuji);
			const sync = attachSync(fuji, {
				url: websocketUrl(`${apiUrl}/workspaces/${fuji.ydoc.guid}`),
				getToken,
				webSocketImpl,
			});
			const presence = sync.attachPresence({ peer });
			const rpc = sync.attachRpc(actions);

			return {
				...fuji,
				sync,
				presence,
				rpc,
				actions,
			};
		},
	});
}
```

This keeps `defineDaemon` as the place for manifest metadata and keeps `start` as the place where live resources are assembled.

### Inline Config

An inline daemon config should show the full contract:

```ts
export default defineConfig({
	hosts: [
		defineDaemon({
			route: 'notes',
			title: 'Notes',
			workspaceId: 'epicenter.notes',
			start: ({ projectDir }) => {
				const notes = openNotes({
					id: 'notes',
					name: 'Notes',
					platform: 'node',
					clientID: hashClientId(projectDir),
				});
				const actions = createNotesActions(notes);
				const sync = attachSync(notes, {
					url: websocketUrl(`${EPICENTER_API_URL}/workspaces/${notes.ydoc.guid}`),
					getToken: createCredentialTokenGetter({
						serverOrigin: EPICENTER_API_URL,
					}),
				});
				const presence = sync.attachPresence({
					peer: {
						id: 'notes-daemon',
						name: 'Notes Daemon',
						platform: 'node',
					},
				});
				const rpc = sync.attachRpc(actions);

				return {
					...notes,
					sync,
					presence,
					rpc,
					actions,
				};
			},
		}),
	],
});
```

If this feels heavy for README examples, that is useful feedback. It means the README is probably trying to teach a local action host, not a daemon.

## Why Sync, Presence, and RPC Belong Together

`sync`, `presence`, and `rpc` are separate objects, but they describe one peer runtime.

`sync` answers: is this workspace connected to the shared document channel?

`presence` answers: who else is on that channel, and how do we identify a target peer?

`rpc` answers: once we have a target peer, how do we invoke one of its actions?

For the daemon CLI, these are not independent optional features. They form a path:

```text
run --peer bob notes.entries_create
  |
  v
route "notes" selects HostedDaemonWorkspace
  |
  v
presence.waitForPeer("bob") finds clientID
  |
  v
rpc.rpc(clientID, "entries_create", input)
  |
  v
remote peer invokes its actions.entries_create
```

Removing any one part breaks the peer story:

| Missing field | What breaks |
| --- | --- |
| `sync` | The route is not actually online as a shared workspace peer. |
| `presence` | The CLI cannot list peers or resolve `--peer` targets. |
| `rpc` | The CLI can find a peer but cannot invoke it. |
| `actions` | The CLI has nothing to describe or invoke. |

That is why requiring all four is clearer than checking each command's immediate dependencies. The daemon is not "whatever fields this command happens to use." The daemon is the peer runtime as a whole.

## Storage Philosophy

Daemon storage should not be standardized in this change.

A daemon should have a standard peer surface. It should not necessarily have a standard persistence stack. Fuji may attach a Yjs log, Opensidian may materialize markdown, another workspace may use SQLite or a browser store. Those are app invariants, not daemon invariants.

The daemon contract should say:

```text
I can start, expose actions, connect sync, show presence, route RPC, and dispose.
```

It should not say:

```text
I store my state in this one prescribed way.
```

That distinction matters. Sync and presence are how the daemon participates in the network. Storage is how a particular workspace preserves or projects state.

## Invariant Audit

### Invariant 1: A Started Daemon Is A Peer

After `host.start(ctx)` resolves, `workspace.sync`, `workspace.presence`, and `workspace.rpc` must exist.

Allowed:

```ts
const actions = {};
const rpc = sync.attachRpc(actions);
```

Not allowed:

```ts
return {
	...doc,
	actions: {},
	sync,
	presence,
};
```

An empty action tree is a valid peer daemon. Missing RPC is not.

### Invariant 2: The Route Is Not Runtime State

The route belongs to `DaemonHostDefinition` and `HostedDaemonWorkspace`. It should not be returned from `start`.

Allowed:

```ts
defineDaemon({
	route: 'notes',
	start: () => workspace,
});
```

Not allowed:

```ts
defineDaemon({
	route: 'notes',
	start: () => ({
		...workspace,
		route: 'notes',
	}),
});
```

The latter repeats the same fact and creates a drift path.

### Invariant 3: Manifest Metadata Is Eager, Runtime Is Lazy

`route`, `title`, `description`, and `workspaceId` must be inspectable without opening the workspace. `start` is the only place that creates live resources.

This avoids hidden side effects during config discovery:

```text
import config
  -> inspect host metadata
  -> validate routes
  -> then start hosts
```

### Invariant 4: App-Specific Runtime Fields Are Allowed But Not Part Of The Daemon Contract

The generic return type can preserve fields like `yjsLog`, but daemon infrastructure should only read `actions`, `sync`, `presence`, `rpc`, and disposal.

This lets app code stay precise while daemon code stays small.

### Invariant 5: A Local-Only Action Bag Is Not A Daemon

If a caller only needs local action introspection and invocation, it should not use `defineDaemon` once the stricter contract lands. That caller needs either a real sync peer or a separately named local host API.

This is the main philosophical cleanup.

## Implementation Plan

### Phase 1: Capture The Contract

- [x] **1.1** Land this spec.
- [x] **1.2** Decide whether `defineDaemon` becomes strict immediately or whether a separate local action host API must be introduced first.
- [x] **1.3** Identify every current `defineDaemon` call site and classify it as "peer daemon" or "local action host smell."

### Phase 2: Tighten Types

- [x] **2.1** Make `sync`, `presence`, and `rpc` required on `DaemonWorkspace`.
- [x] **2.2** Update `isDaemonWorkspace` in `packages/cli/src/load-config.ts` to validate the stricter runtime shape.
- [x] **2.3** Replace optional disposal barrier logic with direct `host.sync.whenDisposed` handling if `whenDisposed` is part of the sync contract.
- [x] **2.4** Remove optional chaining for daemon peer fields in daemon server and CLI code.

### Phase 3: Update Official App Daemons

- [x] **3.1** Keep Fuji returning `actions`, `sync`, `presence`, and `rpc`.
- [x] **3.2** Keep Honeycrisp returning `actions`, `sync`, `presence`, and `rpc`.
- [x] **3.3** Keep Opensidian returning `actions`, `sync`, `presence`, and `rpc`, even if actions stay empty.
- [x] **3.4** Update Zhongwen to attach RPC to its empty action tree.

### Phase 4: Classify Examples, Playgrounds, And Fixtures

- [x] **4.1** Update CLI README examples so daemon examples show sync, presence, and RPC.
- [x] **4.2** Update inline test fixtures to return full fake daemon workspaces.
- [x] **4.3** Review `playground/opensidian-e2e/epicenter.config.ts`; either make it a full peer daemon or mark it as a local-host API candidate.
- [x] **4.4** Review `playground/tab-manager-e2e/epicenter.config.ts`; either make it a full peer daemon or mark it as a local-host API candidate.
- [x] **4.5** If local-only hosts are real, write a separate spec for `defineLocalActionHost` before implementing it.

  > No local-only host API was added. The existing playgrounds and fixtures were moved to full daemon peer shapes instead.

### Phase 5: Simplify Runtime Code

- [x] **5.1** In `/peers`, replace `presence?.peers() ?? new Map()` with direct `presence.peers()`.
- [x] **5.2** In `run-handler`, remove the "no peer RPC attachment" usage error.
- [x] **5.3** In `up`, remove early returns for missing presence and sync.
- [x] **5.4** Revisit error messages. Missing peer attachment should become a config load error, not a command usage error.

### Phase 6: Verify

- [x] **6.1** Run workspace typecheck.
- [x] **6.2** Run CLI typecheck.
- [x] **6.3** Run daemon route tests.
- [ ] **6.4** Run app daemon integration tests.
- [x] **6.5** Run any playground e2e tests affected by stricter config shape.

  > App daemon integration tests were run. Honeycrisp, Opensidian, and Zhongwen passed. Fuji failed because the dirty worktree currently removes the `openFuji` export from `apps/fuji/src/lib/fuji/script.ts`, which is outside this daemon contract change.

## Migration Notes

### Zhongwen

Zhongwen is the smallest real app migration:

```ts
const actions = {};
const presence = sync.attachPresence({ peer });
const rpc = sync.attachRpc(actions);

return {
	...doc,
	yjsLog,
	sync,
	presence,
	rpc,
	actions,
};
```

This does not invent new Zhongwen behavior. It makes Zhongwen a complete daemon peer with an empty action surface.

### Tests

Tests should use a fake daemon workspace helper that includes the full peer contract. That helper can keep behavior tiny:

```ts
function makeFakeDaemonWorkspace(): DaemonWorkspace {
	const peers = new Map();
	return {
		[Symbol.dispose]() {},
		actions: {},
		sync: {
			onStatusChange: () => () => {},
			whenDisposed: Promise.resolve(),
		} as unknown as SyncAttachment,
		presence: {
			peers: () => peers,
			observe: () => () => {},
			waitForPeer: async () =>
				PeerPresenceError.NotFound({
					peerTarget: 'missing',
					sawPeers: [],
					waitMs: 1,
					emptyReason: 'no-peers',
				}),
		} as unknown as PeerPresenceAttachment,
		rpc: {
			rpc: async () => RpcError.Timeout({ timeoutMs: 1 }),
		} as unknown as SyncRpcAttachment,
	};
}
```

The exact fake should match the real attachment types. The important part is that tests stop normalizing partial daemon shapes.

### README Examples

README examples should make a choice.

If the example teaches daemon config, show a full peer daemon:

```ts
defineDaemon({
	route: 'notes',
	title: 'Notes',
	start: () => {
		const notes = openNotes(...);
		const actions = createNotesActions(notes);
		const sync = attachSync(notes, ...);
		const presence = sync.attachPresence(...);
		const rpc = sync.attachRpc(actions);
		return { ...notes, actions, sync, presence, rpc };
	},
});
```

If the example teaches local action invocation, do not use `defineDaemon`. Wait until there is a local action host API, or keep the example out of daemon docs.

## Edge Cases

### Empty Actions

A daemon may have no public actions today.

Expected behavior:

1. `list` shows no runnable descendants under that route.
2. `run route.some.path` returns a usage error because the action is not defined.
3. `peers` still works.
4. `run --peer` can still reach the peer RPC mechanism, then fail based on the missing action path rather than missing infrastructure.

This is coherent because "no actions" is a product fact and "no RPC" is an infrastructure gap.

### Offline Sync

Required `sync` does not mean always connected. A daemon can have a sync attachment whose current status is offline, connecting, or failed.

The contract is:

```text
The daemon has a sync transport and can report its status.
```

The contract is not:

```text
The daemon is connected every time a command runs.
```

This distinction keeps the type honest while still allowing real network failure.

### Materializer-Only Processes

Some processes may watch a workspace and materialize markdown or SQLite without exposing meaningful commands. If they are route-addressed and peer-visible, they are still daemons and should have sync, presence, and RPC.

If they are private implementation details, they should be started inside an app daemon or through a different worker API. They should not become daemon hosts only because `defineDaemon` is convenient.

### Browser Or Extension Hosts

Browser and extension contexts may have a peer descriptor and sync transport but different persistence. That is fine. The daemon contract does not prescribe storage or process model. It prescribes the surfaces the daemon infrastructure can call.

### User-Written Inline Configs

Stricter `DaemonWorkspace` will break inline configs that return only `{ actions, [Symbol.dispose] }`. That is intentional if the API keeps the name `defineDaemon`.

The migration path is either:

1. Add sync, presence, and RPC.
2. Move to a future local-only API if that is the real use case.

## Open Questions

1. **Should `defineDaemon` become strict before a local action host API exists?**

   Options:

   | Option | Result |
   | --- | --- |
   | Make `defineDaemon` strict now | Strongest contract, immediate cleanup, breaks partial inline configs. |
   | Add `defineLocalActionHost` first | Softer migration, but more API surface before we know the need is real. |
   | Keep optional fields | Least disruption, preserves the current smell. |

   Recommendation: make `defineDaemon` strict now. Add `defineLocalActionHost` only if real callers remain after playgrounds and examples are classified.

2. **Should `sync`, `presence`, and `rpc` be grouped as `transport`?**

   A grouped shape is conceptually nice:

   ```ts
   type DaemonWorkspace = {
    actions: Actions;
    transport: {
      sync: SyncAttachment;
      presence: PeerPresenceAttachment;
      rpc: SyncRpcAttachment;
    };
   };
   ```

   Recommendation: defer. The current fields already exist and are easy to require. A `transport` bundle can be a later cleanup if it removes real complexity.

3. **Should daemon storage be standardized?**

   Recommendation: no. Standardize the peer runtime contract, not persistence. Storage needs vary by app and should stay behind app-specific openers and attachments.

4. **Should `workspaceId` be required?**

   Recommendation: not in this change. `workspaceId` is valuable static metadata, but requiring peer transport is the contract cleanup that directly matches CLI behavior. Requiring `workspaceId` can be decided with route validation and discovery requirements later.

5. **Should `workspaceId` match `doc.ydoc.guid` or sync room id?**

   Recommendation: defer. It is a good invariant to explore, but current apps may treat workspace id as product identity and Yjs guid as document identity. Collapsing those concepts needs its own design pass.

6. **Should RPC attach to `actions` or to the whole workspace?**

   Recommendation: keep attaching to `actions`. The CLI already treats action paths as the public callable surface. Exposing the whole workspace over RPC would leak implementation fields.

7. **Should a daemon be allowed to opt out of peer RPC for security?**

   Recommendation: not through missing `rpc`. If a daemon should restrict remote calls, encode that in the action tree or RPC authorization layer. Missing infrastructure is too ambiguous.

## Success Criteria

- [x] `DaemonWorkspace` requires `actions`, `sync`, `presence`, `rpc`, and `[Symbol.dispose]`.
- [x] Official app daemon helpers compile under the stricter contract.
- [x] Zhongwen attaches RPC, even with an empty action tree.
- [x] `packages/workspace/src/daemon/app.ts` no longer treats missing presence as normal.
- [x] `packages/workspace/src/daemon/run-handler.ts` no longer has a "no peer RPC attachment" branch.
- [x] `packages/cli/src/commands/up.ts` no longer skips awareness or status subscriptions because fields are missing.
- [x] CLI README daemon examples show a real peer daemon.
- [x] Tests use full fake daemon workspaces or a deliberately separate non-daemon API.
- [x] Focused daemon tests pass.
- [ ] App daemon integration tests pass.
- [x] Workspace and CLI typechecks pass.

## Files To Consult

| File | Why |
| --- | --- |
| `packages/workspace/src/daemon/types.ts` | Defines `DaemonWorkspace`, `DaemonHostDefinition`, and `HostedDaemonWorkspace`. |
| `packages/workspace/src/daemon/app.ts` | Uses presence for `/peers` and actions for `/list`. |
| `packages/workspace/src/daemon/run-handler.ts` | Uses actions locally and presence plus RPC for `--peer`. |
| `packages/cli/src/load-config.ts` | Runtime validation and disposal behavior for started daemon hosts. |
| `packages/cli/src/commands/up.ts` | Long-lived process lifecycle, presence logging, and sync status logging. |
| `apps/fuji/src/lib/fuji/daemon.ts` | Full app daemon example. |
| `apps/honeycrisp/src/lib/honeycrisp/daemon.ts` | Full app daemon example. |
| `apps/opensidian/src/lib/opensidian/daemon.ts` | Empty-action peer daemon example. |
| `apps/zhongwen/src/lib/zhongwen/daemon.ts` | Needs RPC attachment under the strict contract. |
| `playground/opensidian-e2e/epicenter.config.ts` | Needs classification as peer daemon or local action host smell. |
| `playground/tab-manager-e2e/epicenter.config.ts` | Needs classification as peer daemon or local action host smell. |
| `packages/cli/README.md` | Public examples must not teach partial daemon shapes. |
| `packages/cli/src/load-config.test.ts` | Inline config fixtures likely need full fake daemon workspaces. |
| `packages/workspace/src/daemon/list-route.test.ts` | Minimal workspace fixtures need the stricter shape. |

## Closing Position

The current API is close. The big correction is philosophical, not mechanical: `defineDaemon` should not mean "any route with actions." It should mean "this route starts a peer runtime the daemon can operate."

That makes the repeated optional checks look like what they are: compatibility scaffolding from a looser contract. Once `sync`, `presence`, and `rpc` are required, the daemon code can become simpler and the API name becomes honest.

## Review

**Completed**: 2026-05-01
**Branch**: `codex/explicit-daemon-host-config`

### Summary

`DaemonWorkspace` now requires the full peer runtime: actions, sync, presence, RPC, and disposal. The loader validates that shape, daemon runtime code reads those fields directly, and the official daemon helpers, playground configs, CLI fixture, and README examples now return full peer daemon workspaces.

### Deviations From Spec

- No `defineLocalActionHost` API was added. Existing local-looking examples were updated to full daemon peer shapes instead.
- Historical planning specs were not rewritten. The live code, active spec, README, fixtures, apps, and playground configs were updated.
- Fuji integration verification is blocked by an unrelated dirty change in `apps/fuji/src/lib/fuji/script.ts` that removed the `openFuji` export.

### Verification

- `bun run --filter @epicenter/workspace typecheck`
- `bun x tsc --noEmit --skipLibCheck --allowImportingTsExtensions --module preserve --moduleResolution bundler --target esnext --lib esnext,dom ...`
- `bun test packages/cli/src/load-config.test.ts packages/workspace/src/daemon/list-route.test.ts packages/workspace/src/daemon/run-handler.test.ts`
- `bun test packages/cli/src/commands/up.test.ts`
- `bun test packages/cli/test/e2e-up-cross-peer.test.ts`
- `bun test apps/honeycrisp/src/lib/honeycrisp/integration.test.ts apps/opensidian/src/lib/opensidian/integration.test.ts apps/zhongwen/src/lib/zhongwen/integration.test.ts`
