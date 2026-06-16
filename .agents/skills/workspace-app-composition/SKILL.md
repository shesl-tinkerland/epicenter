---
name: workspace-app-composition
description: 'How a workspace-backed app under `apps/*` is composed: the isomorphic doc factory (`create<App>`), the environment factories (`open<App>Browser` / `open<App>Extension` / tauri), the `#platform/*` build-time platform DI for multi-platform (Tauri) apps, the `session` singleton, daemon/script placement under per-project `workspaces/<app>/`, and the file layout itself. Use when creating a new app, naming or placing the iso/browser/extension factory, wiring `#platform/*` subpath imports for a Tauri seam, choosing between auth-gated (Shape A) vs module-singleton (Shape B), placing the session singleton, or registering daemon/script bindings.'
metadata:
  author: epicenter
  version: '5.0'
---

# Workspace App Layout

A workspace app is composed in layers: a pure isomorphic doc factory, one or
more environment factories that bind it to a runtime (browser, Chrome
extension, Tauri), a single side-effectful session singleton, and (for the two
multi-platform apps) a build-time platform DI seam. Daemon and script bindings
do not live in the app package at all; they live per-project under
`workspaces/<app>/` and are registered through `epicenter.config.ts`.

Two shipped shapes; pick by whether the app gates UI on signed-in identity.

**Shape A**: auth-gated SvelteKit web apps (honeycrisp, zhongwen, fuji). The app
is not a running thing until identity exists, so a `session` singleton owns the
workspace lifecycle and UI lives under `(signed-in)` routes.

**Shape B**: module-level singleton apps (opensidian, tab-manager, whispering).
A module singleton blocks on auth/session readiness and exports a constructed
handle.

## File Layout

Two layouts ship today. Single-platform apps keep the composition files flat at
the package root; the two apps with a `src-tauri/` directory (fuji, whispering)
nest the same files under `src/lib/workspace/` and add a `src/lib/platform/`
seam.

**Flat root** (honeycrisp, opensidian, zhongwen):

```txt
apps/<app>/
|- <app>.ts                  iso schema + create<App>() factory   (package "." export)
|- <app>.browser.ts          browser env factory open<App>Browser()
|- <app>.test.ts             tests
|- project.ts                mount factory <app>()                (package "./project" export)
`- src/lib/
   |- session.ts             the session singleton (NOT session.svelte.ts)
   `- platform/auth/         auth client construction
```

**Nested under `src/lib/workspace/`** (fuji, whispering; both have `src-tauri/`):

```txt
apps/<app>/
|- package.json              "imports" map declares the #platform/* seams
`- src/lib/
   |- workspace/
   |  |- index.ts            iso schema + create<App>() factory   (package "." export)
   |  |- browser.ts          browser env factory open<App>Browser()
   |  |- index.test.ts       tests
   |  `- project.ts          mount factory <app>()                (package "./project" export)
   |- session.ts             the session singleton
   `- platform/              #platform/* impls (X.browser.ts / X.tauri.ts) + types.ts contract
```

Package exports follow the file's actual owner. Every app exports the iso
factory as `.` and the mount factory as `./project`:

```jsonc
// honeycrisp / zhongwen (flat root)
"exports": {
  ".": "./honeycrisp.ts",
  "./project": "./project.ts"
}

// fuji (nested)
"exports": {
  ".": "./src/lib/workspace/index.ts",
  "./project": "./src/lib/workspace/project.ts"
}
```

Opensidian additionally exports `"./browser": "./opensidian.browser.ts"`; the
others do not export their browser factory. That asymmetry is honest, opensidian
has a consumer that needs the bare browser factory and the others do not. Do not
add a `./browser` export to the rest for symmetry's sake.

## Layers

| Layer | File | Shape | Job | Returns |
| --- | --- | --- | --- | --- |
| Iso factory | `<app>.ts` / `workspace/index.ts` | A + B | `create<App>()`: pure doc construction | workspace (`ydoc`, tables, kv, actions) |
| Browser factory | `<app>.browser.ts` / `workspace/browser.ts` | A + B | `open<App>Browser({ signedIn, nodeId })`: bind to browser persistence + sync | iso bundle plus IndexedDB/local storage, collaboration |
| Extension / tauri factory | `<app>.extension.ts` etc. | B | bind to chrome.storage / Tauri APIs | iso bundle plus runtime resources |
| Mount factory | `project.ts` / `workspace/project.ts` | A + B | `<app>(opts?)`: returns the `Mount` a project's `epicenter.config.ts` default-exports | `Mount` (node persistence, materializers) |
| Session singleton | `src/lib/session.ts` | A | `createSession({ ... })`: owns workspace lifecycle, side effects | `session`, `session.require` |
| Auth | `src/lib/platform/auth/` (or `#platform/auth`) | A | auth client construction | `auth` |

The iso factory, browser/extension factory, and mount factory are pure
construction surfaces. Side effects (auth subscriptions, HMR disposal,
persisted state, network) live only in the session singleton (`src/lib/session.ts`).

## Iso Factory

`create<App>()` builds the document and returns the workspace. It is the package
`.` export and the wire contract for sync: every browser, mount, and test
consumer imports it, and forking a table column shape breaks sync compatibility
with peers running the canonical schema.

```ts
export function createHoneycrisp() {
	const workspace = createWorkspace({
		id: HONEYCRISP_ID,
		tables: { /* ... */ },
		kv: {},
	});
	return defineWorkspace({
		...workspace,
		actions: defineActions({
			// Pure workspace actions that depend only on tables.
		}),
	});
}
```

Rules:

- Keep the iso factory free of `node:*`, `bun:*`, `chrome.*`, Tauri APIs,
  `y-indexeddb`, `BroadcastChannel`, and runtime singletons. It must type-check
  and run isomorphically.
- Put pure actions inline as `actions: defineActions({ ... })` in the returned
  workspace when they depend only on tables.
- Keep env-bound actions in the env factory when they need filesystem, SQLite,
  shell, or browser persistence. Extract only when the runtime action set is
  shared or owns a boundary that would be harder to read inline.

## Browser Factory

`open<App>Browser({ signedIn, nodeId })` calls the iso factory, then attaches
local persistence and collaboration.

```ts
export function openHoneycrispBrowser({
	signedIn,
	nodeId,
}: {
	signedIn: SignedIn;
	nodeId: NodeId;
}) {
	const workspace = createHoneycrisp();
	const idb = attachLocalStorage(workspace.ydoc, {
		server: signedIn.server,
		ownerId: signedIn.ownerId,
	});
	const collaboration = openCollaboration(workspace.ydoc, { /* ... */ });
	return { ...workspace, idb, collaboration };
}
```

## Session Singleton (Shape A)

The singleton lives in `src/lib/session.ts` (a plain `.ts` module, not
`session.svelte.ts`). `createSession` owns the workspace lifecycle; the app
re-exports `session.require` under an app-specific name.

```ts
import { createSession } from '@epicenter/svelte/auth';
import { auth } from '#platform/auth'; // fuji; flat-root apps import from $lib/platform/auth

export const session = createSession({ /* auth + build */ });
export const requireHoneycrisp = session.require;
```

This is the only home for the singleton. Do not add a `client.ts` or a second
singleton site.

## Platform DI: the `#platform/*` seam

Multi-platform apps (the two with `src-tauri/`: fuji, whispering) select
browser-vs-Tauri implementations at BUILD time via Node-standard `#platform/*`
subpath imports. This is the canonical mechanism. It replaced the old
`resolve.extensions` / `moduleSuffixes` suffix trick (see "Why not suffixes"
below).

**1. Declare the seam in `package.json` "imports".** Each seam maps a bare
specifier to a Tauri impl and a default (browser) impl:

```jsonc
"imports": {
  "#platform/tauri": {
    "tauri": "./src/lib/platform/tauri.tauri.ts",
    "default": "./src/lib/platform/tauri.browser.ts"
  }
}
```

**2. Consume the bare specifier, with NO platform branch at the call site:**

```ts
import { tauri } from '#platform/tauri';
```

**3. The build picks the impl by condition.** The web build uses `default`
(browser). The Tauri build activates the `tauri` condition in `vite.config.ts`:

```ts
const isTauri = process.env.TAURI_ENV_PLATFORM !== undefined;
// ...
resolve: {
	// Custom conditions REPLACE Vite's defaults, so the
	// ...defaultClientConditions spread is LOAD-BEARING (drop it and all
	// dependency resolution breaks).
	...(isTauri && { conditions: ['tauri', ...defaultClientConditions] }),
},
```

**4. tsconfig needs nothing.** No `moduleSuffixes`, no per-target tsconfig.
Bundler `moduleResolution` reads the `imports` field and lands on `default`
(browser) for the editor and typecheck.

**5. Each seam has a shared contract.** A `types.ts` declares the contract;
both impls annotate against it with a type annotation, not `satisfies`:

```ts
// platform/types.ts
export type Tauri = { /* ... */ };

// platform/tauri.browser.ts
export const tauri: Tauri | null = null; // no native capability on web

// platform/tauri.tauri.ts
export const tauri: Tauri | null = tauriOnly;
```

Use `export const x: Contract = ...`, NOT `satisfies`. `satisfies` would leak the
concrete type and break the lockstep that keeps both variants conforming to the
same shape.

**`.tauri.ts`-only exports bypass the seam.** A symbol that only exists on Tauri
(e.g. whispering's `tauriOnly`) is imported DIRECTLY by `.tauri.ts` files (e.g.
`import { tauriOnly } from '$lib/tauri.tauri'`), not through `#platform/*`
(which resolves to `null` on web).

**The guarantee.** Because the wrong-platform file is never resolved,
`@tauri-apps/*` code is PHYSICALLY ABSENT from the web bundle (a build-time
guarantee, not Rollup tree-shaking). A Tauri-only file imported by shared code
fails the web build instead of shipping a broken runtime.

### Why not suffixes

The old mechanism put `.browser.ts` / `.tauri.ts` ahead of `.ts` in Vite
`resolve.extensions`, mirrored by tsconfig `moduleSuffixes`. That was GLOBAL:
every bare import was magic, which is why a bare `./fuji` once collided with a
`fuji.browser.ts`. The `#platform/*` mechanism is scoped to the `#platform/*`
specifiers only, so the rest of the import graph stays ordinary. Do not
reintroduce `resolve.extensions` suffixes or tsconfig `moduleSuffixes`.

## Daemon and Script Placement

Daemon and script bindings are NOT in the app package. They live per-project
under `workspaces/<app>/` (e.g. `playground/opensidian-e2e/workspaces/opensidian/daemon.ts`)
and are registered through `epicenter.config.ts` at the Epicenter root:

```ts
import { defineConfig } from '@epicenter/workspace';
import opensidian from './workspaces/opensidian/daemon.ts';

export default defineConfig({
	routes: [opensidian],
});
```

The daemon imports the app's mount factory (the `./project` export) to construct
its `Mount`. `epicenter.config.ts` marks the Epicenter root and is the route
registry; `.epicenter/` is machine state under that root, not a discovery marker. The public
lifecycle command is `epicenter daemon up`, not `epicenter serve`.

## Anti-Patterns

- Putting auth, `createPersistedState`, `auth.onStateChange`, or HMR disposal in
  the browser/extension/tauri factory. Those belong in `src/lib/session.ts`.
- Naming the singleton `session.svelte.ts`. It is a plain `src/lib/session.ts`.
- Adding a second singleton home (`client.ts`) to a Shape A app. The singleton
  already lives in `src/lib/session.ts`.
- Putting auth subscriptions or workspace construction in a Svelte component.
  They belong in the session singleton.
- Branching on platform at a `#platform/*` call site. Import the bare specifier
  and let the build select the impl.
- Using `satisfies` on a `#platform/*` impl instead of a `: Contract` annotation.
- Importing a `.tauri.ts`-only symbol through `#platform/*` (it is `null` on web);
  import it directly from the `.tauri` module inside another `.tauri.ts` file.
- Reintroducing `resolve.extensions` suffixes or tsconfig `moduleSuffixes` for
  platform selection.
- Dropping `...defaultClientConditions` from the Tauri `conditions` array.
- Adding a `./browser` package export to honeycrisp/zhongwen/fuji for symmetry
  with opensidian. Keep the asymmetry; only opensidian has a consumer for it.
- Placing `daemon.ts` or `script.ts` inside the app package. They live under a
  project's `workspaces/<app>/` and are registered via `epicenter.config.ts`.
- Restoring `serve` as the public lifecycle command (it is `epicenter daemon up`).
