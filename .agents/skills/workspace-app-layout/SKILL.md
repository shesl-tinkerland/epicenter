---
name: workspace-app-layout
description: 'File layout for workspace-backed apps under `apps/*`: shared workspace definitions, environment factories (`browser.ts`, `extension.ts`, `tauri.ts`), daemon bindings, and the auth/session singleton split. Use when creating a new app, adding platform-specific imports, placing `daemon.ts`, choosing between auth-gated (Shape A) vs module-singleton (Shape B), or wiring `createSession`/`open<App>`.'
metadata:
  author: epicenter
  version: '4.0'
---

# Workspace App Layout

Workspace apps split construction from runtime side effects. Two shipped
shapes; pick by whether the app gates UI on signed-in identity.

**Shape A**: auth-gated SvelteKit web apps (fuji, honeycrisp, zhongwen):

```txt
apps/<app>/src/lib/
|- auth.ts                          createCookieAuth(), exports `auth`
`- session.svelte.ts                singleton: createSession + HMR + signed-in gating
apps/<app>/src/routes/(signed-in)/<app>/
|- workspace.ts                     schema, IDs, pure action factories
|- browser.ts                       browser factory: open<App>Browser({ signedIn, deviceId })
|- daemon.ts                        long-lived daemon factory (cli-side)
`- integration.test.ts
```

No `client.ts`. The singleton lives in `session.svelte.ts`, where
`createSession({ auth, build })` owns the workspace lifecycle. The shared
contract and browser factory sit beside the signed-in routes because the app
isn't a running thing until identity exists.

**Shape B**: module-level singleton apps (opensidian, tab-manager, whispering):

```txt
apps/<app>/src/lib/<app>/
|- index.ts                         schema, IDs, pure action factories
|- browser.ts | extension.ts | tauri.ts   env binding (browser / chrome ext / Tauri)
|- client.ts                        singleton: auth wait + module-level open<App>(...)
|- daemon.ts                        long-lived daemon factory (if applicable)
`- integration.test.ts
```

`client.ts` is the only singleton with side effects; it blocks on
`session.whenReady` / `waitForAuthState` and exports a constructed handle.
Whispering is the simplest variant (no auth, no encryption, Tauri singleton).
Opensidian and tab-manager are scheduled to migrate to shape A
(`specs/20260507T054727-opensidian-tab-manager-create-session.md`); until
then, do not move their singleton during unrelated changes; review churn
isn't worth it.

For both shapes, `index.ts` / `workspace.ts`, `browser.ts`, and `daemon.ts`
stay construction surfaces. Side effects (auth subscriptions, HMR, persisted
state, network) live only in the singleton (`session.svelte.ts` for shape A,
`client.ts` for shape B) or the runtime attachments they explicitly compose.

## Layers

| File | Shape | Job | Imports | Returns |
| --- | --- | --- | --- | --- |
| `index.ts`, `workspace.ts`, or `core.ts` | A + B | Shared workspace contract | Workspace core, schemas, pure action factories | IDs, table/KV definitions, action factories |
| `browser.ts` | A + B | Browser factory | Shared contract plus `attachEncryption`, `attachLocalStorage`, `openCollaboration`, browser caches | Doc bundle plus browser resources |
| `extension.ts` / `tauri.ts` | B | Env binding for non-web runtimes | Shared contract plus chrome.storage / Tauri APIs | Doc bundle plus runtime resources |
| `daemon.ts` | A + B | Long-lived daemon factory | Shared contract plus `attachEncryption`, materializers, `attachDaemonInfrastructure` | `DaemonRuntime` with writer persistence and sync |
| `auth.ts` | A | Auth client construction | `createCookieAuth` (or `createBearerAuth`) | `auth` |
| `session.svelte.ts` | A | App singleton + lifecycle | `createSession` from `@epicenter/svelte`, env factory, auth | `session`, `InferSignedIn`, module-level `getSignedInSession()` |
| `client.ts` | B | App singleton + auth wait | One env factory plus auth/session lifecycle | `auth` plus a running app singleton; module-level `await session.whenReady` |

Daemon factories live beside the shared contract or app binding regardless of
shape. Project configs import daemon modules and list them in `routes`.

## Shared Workspace Factory

When an app keeps an isomorphic opener, it accepts an optional `clientID` so
daemon peers can use stable Yjs identities.

```ts
import type { Keyring } from '@epicenter/encryption';
import { createWorkspace } from '@epicenter/workspace';
import { createFujiActions, fujiTables } from '../workspace.js';

export function openFuji({
	keyring,
	clientID,
}: {
	keyring: () => Keyring;
	clientID?: number;
}) {
	const workspace = createWorkspace({
		id: 'epicenter.fuji',
		keyring,
		tables: fujiTables,
		kv: {},
	});
	if (clientID !== undefined) workspace.ydoc.clientID = clientID;
	const actions = createFujiActions(workspace.tables);
	return {
		...workspace,
		actions,
		batch: (fn: () => void) => workspace.ydoc.transact(fn),
	};
}
```

Rules:

- Keep the shared workspace factory free of `node:*`, `bun:*`, `chrome.*`,
  Tauri APIs, `y-indexeddb`, `BroadcastChannel`, and runtime singletons.
- Use relative imports for schemas when daemon files will import the factory
  outside Vite alias resolution.
- Put pure actions in the shared workspace factory when they depend only on
  tables.
- Keep env-bound actions in the env factory when they need filesystem, SQLite,
  shell, browser persistence, or other runtime state. Opensidian actions stay
  extracted in `actions.ts`.

## Browser Factory

Browser factories mount encrypted stores, encrypted local storage, and
collaboration with the `SignedIn` payload from `createSession`.

```ts
export function openFujiBrowser({
	signedIn,
	deviceId,
}: {
	signedIn: SignedIn;
	deviceId: DeviceId;
}) {
	const ydoc = new Y.Doc({ guid: FUJI_ID, gc: true });
	const { tables, kv } = attachEncryption(ydoc, {
		keyring: signedIn.keyring,
		tables: fujiTables,
		kv: {},
	});
	const actions = createFujiActions(tables);
	const idb = attachLocalStorage(ydoc, {
		server: signedIn.server,
		ownerId: signedIn.ownerId,
		keyring: signedIn.keyring,
	});
	const collaboration = openCollaboration(ydoc, {
		url: roomWsUrl({
			baseURL: signedIn.baseURL,
			ownerId: signedIn.ownerId,
			guid: ydoc.guid,
			deviceId,
		}),
		openWebSocket: signedIn.openWebSocket,
		onReconnectSignal: signedIn.onReconnectSignal,
		waitFor: idb.whenLoaded,
		actions,
	});
	return { ydoc, tables, kv, actions, idb, collaboration };
}
```

Do not restore `sync.peer()` or `describePeer()`. Remote calls use the
collaboration dispatch and presence surfaces.

## Daemon Factory

Daemon factories own the writer side of local persistence.

```ts
export function openFujiDaemon({
	projectDir,
	route,
	yDocClientId,
	deviceId,
	ownerId,
	keyring,
	openWebSocket,
	onReconnectSignal,
}: DaemonWorkspaceContext) {
	const ydoc = new Y.Doc({ guid: FUJI_ID, gc: true });
	ydoc.clientID = yDocClientId;
	const { tables } = attachEncryption(ydoc, {
		keyring,
		tables: fujiTables,
		kv: {},
	});
	const actions = createFujiActions(tables);

	attachBunSqliteMaterializer(ydoc, {
		filePath: sqlitePath(projectDir, ydoc.guid),
		log: createLogger(`${route}-sqlite`),
		tables,
	});
	attachMarkdownMaterializer(ydoc, {
		dir: markdownPath(projectDir, ydoc.guid),
		tables,
		perTable: { entries: { filename: slugFilename('title') } },
	});

	return attachDaemonInfrastructure(ydoc, {
		projectDir,
		ownerId,
		deviceId,
		openWebSocket,
		onReconnectSignal,
		actions,
	});
}
```

The public lifecycle command is `epicenter daemon up`. Do not document daemon
factories as `epicenter serve` consumers.

Single-workspace projects default-export `defineWorkspace({ open })`. Multi-route
projects register daemon modules from the project root:

```ts
import { defineConfig } from '@epicenter/workspace';
import fuji from './workspaces/fuji/daemon.ts';

export default defineConfig({
	daemon: {
		routes: { fuji },
	},
});
```

`epicenter.config.ts` is the project marker and route registry. `.epicenter/`
is project-local data, not a discovery marker.

## Scripts

There is no `script.ts` recipe to copy. Scripts usually skip Yjs entirely:
read materialized files or SQLite, then call daemon actions through
`connectDaemonActions`. See `docs/scripting.md` before adding script-specific
workspace construction.

## Package Exports

Apps that expose daemon factories should export them explicitly. Point each
subpath at the file's actual owner. Signed-in-owned apps may export from
`src/routes/(signed-in)/...`; client-singleton apps usually export from
`src/lib/...`.

```json
{
	"exports": {
		"./workspace": "./src/routes/(signed-in)/fuji/workspace.ts",
		"./openFuji": "./src/routes/(signed-in)/fuji/index.ts",
		"./browser": "./src/routes/(signed-in)/fuji/browser.ts",
		"./daemon": "./src/routes/(signed-in)/fuji/daemon.ts"
	}
}
```

Client-singleton apps use the same subpaths, but point at `src/lib/...`.

Do not export a running `client.ts` singleton from package exports.

## Tests

Every daemon should have an infrastructure test when it adds custom storage,
materializers, or actions:

```txt
daemon opens projectDir
daemon writes rows
daemon disposes and closes writer persistence
fresh daemon opens the same projectDir
fresh daemon observes rows from Yjs log replay and materializer hydration
```

## Anti-Patterns

- Putting auth, `createPersistedState`, `auth.onStateChange`, or HMR disposal in
  `browser.ts` or `daemon.ts`.
- Importing `daemon.ts` from browser code.
- Restoring `serve` as the public lifecycle command.
- Restoring `sync.peer()` or `describePeer()` as the primary remote action API.
- Inlining Opensidian actions back into `browser.ts`.
- Relocating `client.ts` (shape B) or `session.svelte.ts` (shape A) during a daemon-only change without a review reason.
- Adding a `client.ts` to a shape A app: the singleton already lives in `session.svelte.ts`. There is no second home.
- Putting auth subscriptions or workspace construction in a Svelte component: it belongs in the singleton (`session.svelte.ts` or `client.ts`).
