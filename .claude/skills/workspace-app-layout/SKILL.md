---
name: workspace-app-layout
description: How each app under apps/* lays out its workspace client — folder named after the app with three files (index.ts iso factory, <binding>.ts pure env factory, client.ts singleton + auth + lifecycle). Use when creating a new app with a workspace, splitting a single client file, deciding where browser-only or platform-specific imports belong, or naming a new env binding (worker, server, etc.).
metadata:
  author: epicenter
  version: '2.0'
---

# Workspace App Layout

Every app under `apps/*` that has a workspace exposes it as a folder named
after the app, with **three files**: an isomorphic doc factory, a pure
environment factory, and a running client that wires auth + the singleton +
lifecycle.

> **Related skills**: `factory-function-composition` (how the env factory takes injected deps), `workspace-api` (the `attach*` primitives), `monorepo` (where apps live).

## When to Apply This Skill

- Creating a new app under `apps/*` that needs a workspace.
- Splitting a single `client.{svelte.,}ts` file into the three-file layout.
- A non-browser consumer (build config, test, CLI, codegen) needs the doc
  without dragging in `y-indexeddb` or platform APIs.
- Adding a second environment binding to an existing app.

## The Layout

```
apps/<app>/src/lib/<app>/
├── index.ts          ← isomorphic doc factory       (open<App>())
├── <binding>.ts      ← pure env factory             (open<App>(deps))
└── client.ts         ← singleton + auth + lifecycle (the running thing)
```

**Three layers, three files, three jobs.** Each layer composes around the
one below it.

| File | Job | Imports | Returns |
|---|---|---|---|
| `index.ts` | Iso doc factory | `@epicenter/workspace` core, schemas | doc bundle (ydoc, tables, kv, encryption, batch, dispose) |
| `<binding>.ts` | Env factory (pure, no side effects) | `./index` + env-specific `attach*` primitives | doc bundle + env-specific resources (idb, sync, materializers, caches) |
| `client.ts` | Running singleton | `./<binding>` + `createAuth` | `auth` + `<app>` singleton + lifecycle subscriptions |

## Binding Names

`<binding>` names the actual platform when bound to platform APIs, and
generic when not:

| Binding name | Use when the file imports |
|---|---|
| `browser.ts` | `y-indexeddb`, `BroadcastChannel`, plain `fetch`, no framework |
| `tauri.ts` | `@tauri-apps/api/*`, Tauri-specific persistence/IPC |
| `extension.ts` | `chrome.storage`, `chrome.runtime`, MV3 service-worker constraints |
| `worker.ts` | Web Worker globals, no DOM |
| `server.ts` / `node.ts` | Node SSR / CLI / tests |
| `desktop.ts` | Generic Bun/Node desktop with no specific framework (rare) |

Use `tauri.ts` over `desktop.ts` when the file's imports are Tauri-specific.

## The Three Files (Reference)

### `index.ts` — isomorphic factory

```ts
// apps/zhongwen/src/lib/zhongwen/index.ts
import { attachEncryption } from '@epicenter/workspace';
import * as Y from 'yjs';
import { zhongwenKv, zhongwenTables } from '$lib/workspace';

export function openZhongwen() {
	const ydoc = new Y.Doc({ guid: 'epicenter.zhongwen', gc: false });
	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(ydoc, zhongwenTables);
	const kv = encryption.attachKv(ydoc, zhongwenKv);
	return {
		ydoc, tables, kv, encryption,
		batch: (fn: () => void) => ydoc.transact(fn),
		[Symbol.dispose]() { ydoc.destroy(); },
	};
}
```

### `<binding>.ts` — pure env factory (with auth + device dep injection)

For apps with sync, the factory takes `auth` and a `device` descriptor as
injected dependencies. `auth` powers sync's `getToken`. `device` is the
identity descriptor (`{ id, name, platform }`) — the factory adds `offers`
(via `actionManifest(actions)`) and publishes the full `PeerDevice` into
awareness so other peers can discover and dispatch to this runtime.

```ts
// apps/fuji/src/lib/fuji/browser.ts
import type { AuthClient } from '@epicenter/auth-svelte';
import {
	actionManifest, attachBroadcastChannel, attachIndexedDb, attachSync,
	type DeviceDescriptor, toWsUrl,
} from '@epicenter/workspace';
import { openFuji as openFujiDoc } from './index';

export function openFuji({
	auth,
	device,
}: {
	auth: AuthClient;
	device: DeviceDescriptor;
}) {
	const doc = openFujiDoc();
	const idb = attachIndexedDb(doc.ydoc);
	attachBroadcastChannel(doc.ydoc);
	const sync = attachSync(doc.ydoc, {
		url: toWsUrl(/* ... */),
		waitFor: idb.whenLoaded,
		awareness: doc.awareness.raw,
		getToken: async () => auth.getToken(),
		actions: doc.actions,
	});
	doc.awareness.setLocal({
		device: { ...device, offers: actionManifest(doc.actions) },
	});
	return { ...doc, idb, sync, whenReady: idb.whenLoaded };
}
```

For apps without sync/auth (zhongwen, whispering), the factory takes no
deps:

```ts
export function openZhongwen() {
	const doc = openZhongwenDoc();
	const idb = attachIndexedDb(doc.ydoc);
	attachBroadcastChannel(doc.ydoc);
	return { ...doc, idb, whenReady: idb.whenLoaded };
}
```

### `client.ts` — running singleton + auth + device + lifecycle

```ts
// apps/fuji/src/lib/fuji/client.ts
import { AuthSession, createAuth } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';
import { getOrCreateDeviceId } from '@epicenter/workspace';
import { openFuji } from './browser';

const session = createPersistedState({
	key: 'fuji:authSession',
	schema: AuthSession.or('null'),
	defaultValue: null,
});

export const auth = createAuth({ baseURL: APP_URLS.API, session });

export const fuji = openFuji({
	auth,
	device: {
		id: getOrCreateDeviceId(localStorage),
		name: 'Fuji',
		platform: 'web',
	},
});

auth.onSessionChange((next, previous) => {
	if (next === null) {
		fuji.sync.goOffline();
		if (previous !== null) void fuji.idb.clearLocal();
		return;
	}
	fuji.encryption.applyKeys(next.encryptionKeys);
	if (previous?.token !== next.token) fuji.sync.reconnect();
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => { auth[Symbol.dispose](); });
}
```

For tab-manager (async chrome.storage), the descriptor is built as a
Promise — the factory accepts `Promise<DeviceDescriptor<DeviceId>>` and
publishes awareness in the background. `tabManager.whenReady` gates
dependent work without forcing TLA at the call site.

For apps without auth (whispering), `client.ts` is minimal but still exists
for consistency:

```ts
// apps/whispering/src/lib/whispering/client.ts
import { openWhispering } from './tauri';
export const whispering = openWhispering();
```

## The Imports — what consumers do

**Consumers always import from `client.ts`.** Same canonical function name
(`open<App>`) only matters for internal composition; consumers see the
singleton.

```ts
// app code — always import the singleton
import { fuji } from '$lib/fuji/client';
fuji.tables.entries.set(...);     // direct property access — no destructuring
await fuji.whenReady;

// app code that also needs auth
import { auth, fuji } from '$lib/fuji/client';

// Node tooling / build config / test — import the iso factory
import { openFuji } from './apps/fuji/src/lib/fuji';
```

**Do not destructure the singleton** at call sites:

```ts
// ❌ Don't
const { tables, actions } = fuji;
tables.entries.set(...);

// ✅ Do
fuji.tables.entries.set(...);
```

Direct property access keeps the origin visible at every call site and
avoids stale references when the singleton is rebuilt (HMR, tests).

## Three Rules That Make Bleed Impossible

1. **`index.ts` may import only isomorphic deps.** No `attach*` for
   persistence/transport. No `node:*`, `bun:*`, `chrome.*`,
   `@tauri-apps/*`, `y-indexeddb`, `BroadcastChannel`.
2. **`<binding>.ts` is a pure factory.** Imports `./index` + env-specific
   `attach*`. No top-level side effects, no `createAuth`, no singleton.
   Takes injected dependencies (like `{ auth }`) when needed.
3. **`client.ts` is the only file with side effects.** Constructs auth,
   instantiates the singleton, wires `onSessionChange` and HMR. Imports
   from `./<binding>` only.

If all three hold, browser bundlers cannot reach Node code (and vice
versa) through the import graph; tests can construct fresh docs without
booting auth or chrome.storage; HMR can dispose and rebuild the client
without re-importing the world.

## What Goes Where

| Concern | File |
|---|---|
| `Y.Doc` construction + GUID | `index.ts` |
| `attachEncryption` + tables + kv + awareness | `index.ts` |
| `batch` helper | `index.ts` |
| `[Symbol.dispose]() { ydoc.destroy() }` | `index.ts` |
| `actions` (when iso — depends only on `tables`) | `index.ts` |
| `actions` (when env — depends on browser persistence, e.g. opensidian) | `<binding>.ts` |
| `attachIndexedDb`, `attachBroadcastChannel` | `browser.ts` / `extension.ts` |
| `attachSqlite`, filesystem materializers | `tauri.ts` |
| `attachSync` (uses `WebSocket`) | `<binding>.ts` |
| Per-row content caches that fetch over the network | `<binding>.ts` |
| `createPersistedState({ key, ... })` for the auth session | `client.ts` |
| `createAuth(...)` | `client.ts` |
| `auth.onSessionChange(...)` | `client.ts` |
| HMR `import.meta.hot.dispose` | `client.ts` |
| Singleton `export const <app> = open<App>(...)` | `client.ts` |
| Top-level `await` for env-specific init (e.g. `await session.whenReady` for chrome.storage) | `client.ts` |
| `actionsToAiTools(opensidian.actions)` (uses singleton) | `client.ts` |

## Naming Decisions, Pinned

| Decision | Choice | Why |
|---|---|---|
| Folder name | The app name (`zhongwen/`, `whispering/`) | Self-describing imports. Maps to subpath exports if ever packaged. |
| Iso file | `index.ts` | Default entry; matches `"."` subpath. |
| Env file | `<binding>.ts`, single word | Folder is the namespace. Specific (`tauri`, `extension`) when bound to platform APIs; generic (`browser`) otherwise. |
| Singleton file | `client.ts` | The running, configured client. Always the consumer's import target. |
| Function name | `open<App>` in `index.ts` and `<binding>.ts` | Same canonical verb+noun. The env factory shadows the iso name via `import { open<App> as open<App>Doc } from './index'`. |
| Singleton const | Lowercase `<app>`, only in `client.ts` | The singleton matches the folder name. |
| Verb | `open` over `create`/`make` | Signals "resource needing teardown" — pairs with `[Symbol.dispose]`. |
| Property access | `<app>.tables`, `<app>.actions` — no destructure at call sites | Origin stays visible; survives singleton rebuild. |
| Always have `client.ts` | Even for apps without auth/sync | Consistency. Cost is one tiny file. |

## Common Variations

### App without auth or sync (whispering)

`<binding>.ts` factory takes no deps. `client.ts` is just
`export const <app> = open<App>()`.

### App with `await` at module top-level (tab-manager)

`await session.whenReady` (chrome.storage hydration) lives in `client.ts`,
before `createAuth`. Importing `index.ts` from a Node config does not
trigger the await chain.

### App where `actions` depend on env state (opensidian)

If `actions` use `fs` or `sqliteIndex` (which require browser
persistence), they live in `<binding>.ts`, not `index.ts`. The iso file
is then minimal — just doc + encryption + tables + kv.

### Env file using Svelte runes

Name the file `<binding>.svelte.ts` (e.g. `browser.svelte.ts`). Folder
name is unchanged.

## Anti-Patterns

- **Putting auth + singleton in `<binding>.ts`.** Conflates the env
  factory with lifecycle. `<binding>.ts` is pure construction; `client.ts`
  owns the running thing.
- **Destructuring the singleton at call sites** (`const { tables } = fuji`).
  Hides the origin and breaks if the singleton ever needs reconstruction.
  Use `fuji.tables.*` directly.
- **`core.ts` for the iso file.** Generic layering noun. `index.ts` is
  conventional.
- **`<App>Doc` suffix on the iso function.** Path disambiguates; same
  function name keeps it grep-able. Local rename inside `<binding>.ts`
  (`as open<App>Doc`) is the only place it appears.
- **`browser.ts` for a Chrome extension or Tauri app.** Hides the actual
  platform. Use `extension.ts` / `tauri.ts`.
- **Module-scope side effects in `index.ts`.** Every consumer constructs
  the doc just by importing — hostile to tests and codegen.
- **Cross-environment imports** (`browser.ts` importing `tauri.ts`).
  Breaks bleed prevention. Compose through `index.ts` instead.

## Reference Implementation

`apps/zhongwen/src/lib/zhongwen/{index,browser,client}.ts` is the
canonical reference for the simplest case (no sync, no awareness). For
sync + auth + cache, see fuji or honeycrisp. For platform-specific files,
see whispering (Tauri) or tab-manager (Chrome extension).

## Migrating an Existing App

1. Make `apps/<app>/src/lib/<app>/` directory.
2. **`index.ts`**: copy iso code (Y.Doc, encryption, tables, kv, batch,
   dispose) as `open<App>()`.
3. **`<binding>.ts`**: copy env-specific factory pieces (idb, BC, sync,
   caches, env-bound actions). Compose around iso. Take `{ auth }` if
   sync needs it. **No singleton, no `createAuth`, no
   `onSessionChange`.**
4. **`client.ts`**: `createAuth`, instantiate singleton (`open<App>({ auth })`),
   wire `onSessionChange` and HMR dispose, derive `workspaceAiTools` if
   any.
5. Update call sites: `import { ... } from '$lib/client.svelte'` →
   `import { <app> } from '$lib/<app>/client'`. Replace bare `tables`,
   `actions` etc. with `<app>.tables`, `<app>.actions`. **No
   destructuring** of the singleton at call sites.
6. Delete old `client.{svelte.,}ts`.
7. Typecheck + build. Verify no `node:*`/`bun:*` imports leaked into the
   browser bundle.
