# Epicenter architecture
Epicenter is one composition story. The core packages define the local-first model, the middle layer turns that model into app-shaped tools, and the apps decide which runtime pieces to compose.
The current center is `createWorkspace -> create<App> -> open<App>Browser/open<App>Daemon/open<App>Tauri`. That order matters because Epicenter keeps schema definition pure, keeps the shared app model isomorphic, and pushes runtime side effects to the edge.
This is the five-minute map. It explains how the packages interlock without redoing the full `@epicenter/workspace` README.

## The stack in one picture
The dependency shape runs bottom to top. Apps depend on middleware; middleware depends on the core; the core stays small and reusable.

```text
+----------------------------------------------------------------------------+
| APPS                                                                       |
|                                                                            |
| opensidian   whispering   tab-manager   fuji   zhongwen                    |
| honeycrisp   dashboard    api           landing                            |
+----------------------------------------------------------------------------+
                                      |
                                      v
+----------------------------------------------------------------------------+
| MIDDLEWARE                                                                 |
|                                                                            |
| @epicenter/svelte      (packages/svelte-utils)                             |
| @epicenter/filesystem                                                      |
| @epicenter/skills                                                          |
| @epicenter/workspace/ai                                                    |
+----------------------------------------------------------------------------+
                                      |
                                      v
+----------------------------------------------------------------------------+
| CORE                                                                       |
|                                                                            |
| @epicenter/workspace   @epicenter/sync   @epicenter/constants   @epicenter/ui |
+----------------------------------------------------------------------------+
```
`@epicenter/workspace` is the center of gravity. It defines the schema layer, creates the live Yjs-backed client, owns the extension lifecycle, and exposes tables, KV, documents, presence, and actions.
`@epicenter/sync` is the wire format, not the app model. It exports protocol primitives like `encodeSyncStep1`, `encodeSyncUpdate`, `decodeSyncMessage` so server and client can speak the same binary language without duplicating protocol logic.
`@epicenter/constants` is the routing glue. It gives apps one source of truth for URLs, ports, and versioning so sync endpoints, auth URLs, and cross-app links do not drift.
`@epicenter/ui` is the shared presentation layer. It knows Svelte components, not Yjs semantics.
The middleware layer is where workspace data starts feeling like an application. `@epicenter/svelte` turns workspace helpers into reactive Svelte state, `@epicenter/filesystem` turns workspace rows and documents into a POSIX-style filesystem, `@epicenter/skills` proves that whole workspaces can be packaged and embedded as data products, and `@epicenter/workspace/ai` bridges workspace actions into LLM-callable tools.
The apps are thin by comparison. Each app owns a shared `create<App>()` model, then runtime openers attach browser, daemon, or Tauri concerns on top.

## The lifecycle: define, create, open, attach
The verbs are the architecture. If you remember nothing else, remember that Epicenter keeps these stages separate on purpose.

### 1. Define is pure
`defineTable` and `defineKv` are pure declarations. They do not create a `Y.Doc`, open IndexedDB, start a WebSocket, or touch the network.

```ts
import { field } from '@epicenter/field';
import {
	defineKv,
	defineTable,
} from '@epicenter/workspace';
import Type from 'typebox';

const files = defineTable({
	id: field.string(),
	name: field.string(),
});

const themeMode = defineKv(
	Type.Union([Type.Literal('light'), Type.Literal('dark'), Type.Literal('system')]),
	() => 'system',
);
```

That purity is what makes cross-package reuse work. The same table and KV declarations can be imported by an app, a CLI tool, a migration utility, a test, or another package without dragging runtime side effects along for the ride.

### 2. `createWorkspace` is where the live bundle appears
`createWorkspace({ id, tables, kv })` is the boundary where static meaning turns into live state. It allocates the `Y.Doc`, registers and activates every typed table and KV slot atomically, and returns a typed bundle. The bundle owns the Y.Doc lifecycle: `[Symbol.dispose]()` calls `ydoc.destroy()`, and cascade disposal tears every attached store down.

```ts
import { createWorkspace } from '@epicenter/workspace';

const workspace = createWorkspace({
	id: 'example.app',
	tables: { files },
	kv: { themeMode },
});

workspace.tables.files.set({ id: 'readme.md', name: 'README.md' });
```

The split is conceptual, not cosmetic. Definitions describe what data means; `createWorkspace` is the runtime that can actually hold and mutate that data.

### 3. App factories create the shared model
Apps wrap `createWorkspace` in a per-app factory. That is where the app id, table set, actions, and shared child-doc model live.

```txt
createWorkspace()
  -> createFuji()
    -> openFujiBrowser()
    -> fuji() (mount)
```

Use `defineWorkspace()` when returning the composed object so TypeScript keeps the exact inferred bundle shape after spreads.

### 4. Runtime openers attach resources
There is no plugin chain. Persistence, indexing, and materializers all mount through `attach*` functions; the workspace's network surface (sync + presence + dispatch) mounts through the `openCollaboration` primitive. Runtime openers compose them inline against `workspace.ydoc` after `create<App>()`.

The example below syncs a cloud document. A cloud doc is owned by the authenticated `ownerId` and addressed by its own `ydoc.guid`, so the client builds the URL with `roomWsUrl({ baseURL, ownerId, guid: ydoc.guid, nodeId })`; the server resolves it from the authenticated owner and room id. There is no workspace lookup.

```ts
import {
	attachIndexedDb,
	createWorkspace,
	openCollaboration,
	roomWsUrl,
} from '@epicenter/workspace';

const workspace = createWorkspace({
	id: 'example.app',
	tables: { files },
	kv: { themeMode },
});
const idb = attachIndexedDb(workspace.ydoc);
const collaboration = openCollaboration(workspace.ydoc, {
	url: roomWsUrl({
		baseURL: auth.baseURL,
		ownerId,
		guid: workspace.ydoc.guid,
		nodeId,
	}),
	openWebSocket: auth.openWebSocket,
	onReconnectSignal: auth.onStateChange,
	waitFor: idb.whenLoaded,
	actions: {},
});
```

Ordering is lexical. `openCollaboration` reads `idb.whenLoaded` as `waitFor` because `idb` is already in scope. Later attachments see earlier ones directly. There is no context object to route through.

For extensions that need their own Y.Doc per row (file content, note bodies), use sub-doc primitives like `attachRichText(childYdoc)` or `attachTimeline(childYdoc)` against a raw `Y.Doc`, then mount `openCollaboration` on it with an empty `actions` registry. Inbound dispatch frames reply `ActionNotFound`; the byte transport and presence channel are identical.

### 5. Collaboration is just another runtime opener, but it changes the topology
`openCollaboration` does not own the document. It attaches to a Y.Doc that already exists and starts moving CRDT updates between peers. The relay publishes presence over its own channel; cross-device dispatch rides a plain HTTP POST. The `waitFor: idb.whenLoaded` option ensures local state is replayed first, so the initial handshake is a delta, not a full document transfer.

Local state exists first, then optional durability, then optional network coordination.

## The async boundary is `whenReady`
The builder runs synchronously, but attachments load asynchronously. Conventionally the bundle exposes a `whenReady` promise, usually `idb.whenLoaded`, so callers can await full local availability:

```ts
// Reactive callers (Svelte $effect, {#await}) construct and gate on whenReady.
const workspace = createWorkspace({ id: 'example.app', tables, kv });
const idb = attachIndexedDb(workspace.ydoc);
await idb.whenLoaded;
```

That promise is the line between construction and full availability. Construct synchronously, await whichever attachment exposes the relevant readiness signal.

## Disposal cascades from `ydoc.destroy()`
Teardown runs through Yjs itself. Every async `attach*` function registers `ydoc.once('destroy')` internally, so when the workspace bundle's `[Symbol.dispose]()` calls `ydoc.destroy()`, every attachment starts teardown in parallel. Attachments with genuine async cleanup expose `whenDisposed` for the callers that need a barrier:

```ts
workspace[Symbol.dispose]();
await workspace.idb.whenDisposed;
await workspace.collaboration.whenDisposed;
```

Browser bundles expose `wipe()` for explicit local cleanup such as "Forget this device." Sign-out does not call it. The wipe sequence disposes the live bundle, awaits the async attachments needed to unblock storage deletion, then deletes persisted local state. The refcounted cache still calls `[Symbol.dispose]()` on the last release after the `gcTime` grace period; it does not aggregate an async disposal barrier.

## Write and read flow
Writes always hit Yjs first. Everything else reacts to that state instead of becoming a competing source of truth.

```text
WRITE FLOW

app code / action / UI event
            |
            v
   workspace.tables / kv / documents
            |
            v
          Y.Doc
            |
   +--------+---------------+---------------+
   v        v               v               v
persistence sync       sqlite index   markdown/file views
IndexedDB   WebSocket  or search      or other materializers
SQLite      relay      extensions     built from workspace data
```

Reads split by purpose. Simple reads stay in the workspace client, while derived reads can come from extension exports built on top of that same client state.

```text
READ FLOW

          Y.Doc
            |
   +--------+---------------+-------------------------+
   v        v               v                         v
tables      kv             documents                 extensions
typed rows  settings       per-row content docs      indexes/materializers
   |         |               |                         |
   +---------+---------------+-------------------------+
                             |
                             v
                          app UI
```

That model is why Epicenter can mix SQL-like lookup, filesystem semantics, and collaborative document editing without splitting the truth into three different stores. They are three views over one CRDT core.

## Opensidian is the best concrete example
Opensidian composes nearly every layer inline in a per-app browser opener. Its schema starts with `filesTable` from `@epicenter/filesystem`, adds chat tables locally, and constructs the shared app model with `createOpensidian`.

```ts
import {
	attachIndexedDb,
	defineActions,
	defineQuery,
	defineWorkspace,
	openCollaboration,
	roomWsUrl,
} from '@epicenter/workspace';
import { createOpensidian } from 'opensidian';

export function openOpensidianBrowser() {
	const workspace = createOpensidian();
	const idb = attachIndexedDb(workspace.ydoc);
	const fs = attachYjsFileSystem(workspace.ydoc, workspace.tables.files, fileContent);
	const sqliteIndex = createSqliteIndex({
		readContent: fileContent.read,
		index: fs.index,
	})({ tables: workspace.tables });
	const actions = defineActions({
		files_search: defineQuery({
			handler: async ({ query }) => sqliteIndex.exports.search(query),
		}),
	});
	const collaboration = openCollaboration(workspace.ydoc, {
		url: roomWsUrl({
			baseURL: auth.baseURL,
			ownerId,
			guid: workspace.ydoc.guid,
			nodeId,
		}),
		openWebSocket: auth.openWebSocket,
		onReconnectSignal: auth.onStateChange,
		waitFor: idb.whenLoaded,
		actions,
	});
	return defineWorkspace({ ...workspace, idb, collaboration, fs, sqliteIndex, actions });
}
```

That bundle then feeds other middleware packages. `attachYjsFileSystem(workspace.ydoc, workspace.tables.files, fileContent)` turns the files table plus content docs into a real virtual filesystem, and its `fs.index` is the single owner of path validity that the sqlite mirror converges to; `actionsToAiTools(workspace)` from `@epicenter/workspace/ai` turns workspace actions into chat tools; per-row content docs use sub-doc primitives like `attachRichText`; `createCookieAuth()` or `createBearerAuth()` from `@epicenter/svelte/auth` coordinates identity, fetch, and WebSocket auth while `@epicenter/auth` provides the signed-in identity that supplies `ownerId` and the WebSocket transport.

```text
createOpensidian()
    |
    +-- workspace.ydoc, workspace.tables, workspace.kv
    +-- attachIndexedDb(workspace.ydoc)
    +-- openCollaboration(workspace.ydoc, { url, openWebSocket, onReconnectSignal, waitFor: idb.whenLoaded, actions })
    |
    +-- attachYjsFileSystem(...)              -> editor + terminal + file tree
    +-- createSqliteIndex({ index: fs.index })-> SQL mirror, paths owned by fs.index
    +-- actionsToAiTools(...).tools           -> local AI tool execution
    +-- actionsToAiTools(...).definitions     -> wire payload for chat requests
    +-- attachRichText(childYdoc) per file    -> per-row content docs
    +-- fromTable / fromKv / auth             -> reactive Svelte app state
```

That is the whole monorepo in miniature. The app is mostly composition code because the packages under it already agree on the same runtime shape.

## The sync philosophy is dumb server, smart client
The server is a relay, not the authority. Clients own schema meaning, table helpers, migrations, action handlers, and most of the user-facing behavior.

`@epicenter/sync` reflects that philosophy in its API. It exports protocol encode/decode functions, while `openCollaboration` plugs those primitives into a live workspace that already knows how to read and write its own data.

That means the server does not need to understand your tables. It forwards Yjs sync messages. Presence is server state: the relay owns the `connections` map and pushes a `presence` text frame, the full list of connected installs, on every change. Cross-device dispatch is a plain HTTP POST the relay routes to the recipient's socket. Neither rides the CRDT, and neither needs the server to decode your data.

This is what "smart client" means here. The client can boot locally, read persisted state, expose actions, open document timelines, and keep working offline before the network helps at all.

This is what "dumb server" means here. The server helps peers find each other and exchange updates, but it is not where the data model becomes valid or meaningful.

## The shortest accurate mental model
Epicenter defines data first. `@epicenter/workspace` gives that data a live Yjs document via `createWorkspace({ id, tables, kv })`, app packages wrap it as `create<App>()`, runtime openers attach durability and transport, middleware packages reinterpret the same bundle for files, skills, Svelte state, and AI tools, and the apps compose those layers into actual products.

Everything after that is detail. Useful detail, but still detail.
