# Collapse Tauri-only services into a single namespace

**Status:** Implemented, current API updated after the original proposal
**Scope:** apps/whispering
**Author:** working session
**Related:** `docs/articles/20260525T234034-two-files-one-import-build-time-platform-injection.md`, `apps/whispering/specs/20260526T010258-build-time-platform-di.md`

## TL;DR

Move Tauri-only reusable capabilities (`fs`, `permissions`, `window`, `tray`, `globalShortcuts`, `autostart`) out of `apps/whispering/src/lib/services/<cap>/` and into a single file `apps/whispering/src/lib/tauri.tauri.ts`. Replace the per-capability `index.browser.ts` throwing stubs with one file: `tauri.browser.ts`, which exports only `tauri = null`. Shared consumers use `import { tauri } from '$lib/tauri'` and narrow with `if (tauri)` or optional chaining. Tauri-gated `*.tauri.ts` files use `import { tauriOnly } from '$lib/tauri'`. App-owned Rust commands, including shell execution and upload encoding, live in `$lib/tauri/commands`. The `services/` folder shrinks to only genuinely dual-implementation services (`clipboard`, `text`, `http`, `notifications`, `os`, `sound`, `download`, `analytics`, `blob-store`, `recorder`).

Current implementation note: the original sketch used a default export and non-null assertions in Tauri-only files. The shipped API uses named exports instead. `tauri` is nullable and browser-safe; `tauriOnly` is non-null and intentionally absent from `tauri.browser.ts`.

## The problem

The current Tauri-only services pretend to be dual-implementation services. Each lives in `services/<cap>/index.tauri.ts` and most have a sibling `services/<cap>/index.browser.ts` whose only job is to satisfy Vite's web build resolver and throw at runtime if called. The throw is unreachable in practice because consumers gate calls behind `window.__TAURI_INTERNALS__`.

Concrete shape today:

```
services/
├── _tauri-stub.ts                              shared `unreachable` throw
├── fs/
│   ├── index.tauri.ts                          real Rust-backed impl
│   └── index.browser.ts                        throwing stub
├── command/         (same)
├── permissions/     (same)
├── ffmpeg/
│   ├── index.tauri.ts
│   ├── index.browser.ts
│   └── shared.ts                               platform-neutral constants
├── global-shortcut-manager/  (same)
├── autostart/
│   └── index.tauri.ts                          no browser stub (no web-reachable consumer)
├── tray/
│   └── index.tauri.ts                          no browser stub (same reason)
└── clipboard/, text/, http/, ...               genuinely dual-impl
```

Three things are wrong with this:

**The pattern lies.** `fs` has no web implementation, never has, never will. Calling it a "service" with a "web variant" puts it in the same shape category as `clipboard`, which does have both. That shape category is a fiction for the Tauri-only entries.

**The stub files exist to satisfy Vite, not the program.** Five files in `services/*/index.browser.ts` exist solely because some web-bundled file imports the path. They throw if called, but they're never called. They're build-time scaffolding masquerading as runtime code.

**The asymmetry between `autostart`/`tray` and the others isn't principled.** `autostart` and `tray` lack browser stubs because nothing web-bundled reaches them directly. That distinction is invisible from the folder layout. A new contributor looking at the tree can't tell which services need stubs and which don't.

The same asymmetric refusal applies: refuse to model "Tauri-only capability" as a special case of "dual-impl service." Pull it out into its own namespace, give it its own consumer pattern, and let the symmetry between dual-impl services (which all have two real implementations) actually mean something.

## The proposal

### One file replaces the seven

```
apps/whispering/src/lib/
├── tauri.tauri.ts        all Tauri capabilities, ~250 lines
├── tauri.browser.ts      `export const tauri = null;`
└── services/             only dual-impl services live here
```

### The Tauri file

`tauri.tauri.ts` is one file with capability sections. Each section defines an error type and a capability object. The file ends with one composition line and one cast:

```ts
// $lib/tauri.tauri.ts
import { invoke } from '@tauri-apps/api/core';
import { readFile } from '@tauri-apps/plugin-fs';
import { register, unregister } from '@tauri-apps/plugin-global-shortcut';
import { TrayIcon } from '@tauri-apps/api/tray';
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';
import { defineErrors } from 'wellcrafted/error';
import { tryAsync, Ok } from 'wellcrafted/result';

// fs ----------------------------------------------------------------
export const FsError = defineErrors({
  ReadFilesFailed: ['cause'],
});

const fs = {
  pathsToFiles: (paths: string[]) => tryAsync({ /* ... */ }),
};

// permissions, window, tray, globalShortcuts, autostart follow the same shape

export const tauriOnly = {
  fs,
  permissions,
  window,
  tray,
  globalShortcuts,
  autostart,
};

export type Tauri = typeof tauriOnly;
export const tauri: Tauri | null = tauriOnly;
```

The `Tauri | null` annotation on `tauri` is the only piece of compile-time ceremony. It forces shared consumers to narrow before access, which gives us the runtime gate for free. `tauriOnly` stays non-null for files that are already gated by the `.tauri.ts` suffix.

### The browser file

```ts
// $lib/tauri.browser.ts
export const tauri = null;
```

One runtime export. No imports. No type annotations. Vite's `resolve.extensions` picks this on web builds, the Tauri file on Tauri builds. The whole `tauri/*` import graph never enters the web bundle because nothing reaches it. `tauriOnly` is intentionally absent here, so shared-code misuse fails at build time.

### Consumer pattern

Every consumer looks the same:

```ts
import { tauri } from '$lib/tauri';

// Imperative gate
if (tauri) {
  await tauri.fs.pathsToFiles(paths);
  await tauri.tray.setIcon('IDLE');
}

// Or optional chain
await tauri?.fs.pathsToFiles(paths);
```

The optional chain is the platform gate. No `window.__TAURI_INTERNALS__` at call sites. No `await import()` for module loading. The variable name (`tauri`) tells the reader what's gated. The type system forces the narrow.

Inside `*.tauri.ts` files, the build suffix is already the gate:

```ts
import { tauriOnly } from '$lib/tauri';

await tauriOnly.fs.pathsToFiles(paths);
```

## Type story

`apps/whispering/tsconfig.json` already has:

```json
"moduleSuffixes": [".tauri", ".browser", ""]
```

TypeScript resolves `import { tauri } from '$lib/tauri'` to `tauri.tauri.ts` for type-checking, so consumers see `Tauri | null` as the type. On web at runtime the import resolves to `tauri.browser.ts` which exports `null`. The type and runtime agree: in both worlds the value is "namespace or null."

This is why the browser file does not need to import any type. The `.tauri.ts` file is the single source of type truth. The `.browser.ts` file is the single source of runtime truth on web. Vite + `moduleSuffixes` keeps them in sync without any explicit shared type declaration in the browser file.

## What gets deleted

| Path | Reason |
|---|---|
| `services/_tauri-stub.ts` | `unreachable` no longer used; no stubs to throw |
| `services/fs/index.tauri.ts` | inlined into `tauri.tauri.ts` |
| `services/fs/index.browser.ts` | no longer needed (`$lib/tauri` resolves to `tauri.browser.ts`) |
| `services/fs/` (folder) | empty after the two deletes above |
| `services/permissions/*` | same |
| `services/global-shortcut-manager/*` | same |
| `services/autostart/index.tauri.ts` | same |
| `services/tray/index.tauri.ts` | same |
| `rpc/desktop/index.browser.ts` | rpc/desktop barrel rewires through `$lib/tauri`; no separate stub needed |
| Stub pattern paragraphs in `services/README.md` | obsolete |
| Stub explanation in `ARCHITECTURE.md` | obsolete |

The exact count changed as app-owned commands moved to `$lib/tauri/commands`, but the deletion rule stayed the same: no per-capability browser stubs for Tauri-only surfaces.

## What stays in `services/`

The genuinely dual-implementation services. These each have a real browser implementation and a real Tauri implementation that compose against a shared interface:

```
services/
├── clipboard/    {index.tauri.ts, index.browser.ts, types.ts}
├── text/         same
├── http/         same
├── notifications/ same
├── os/           same
├── sound/        same
├── download/     same
├── analytics/    same
├── blob-store/   index.{tauri,browser}.ts + file-system.tauri.ts + web.ts + types.ts
├── recorder/     navigator.ts (shared) + cpal.tauri.ts + index.{tauri,browser}.ts + device-stream.ts + types.ts
├── transcription/ runtime-DI; provider chosen by settings
├── transformations/ runtime-DI; provider chosen by settings
└── completion/   runtime-DI; provider chosen by settings
```

Three patterns coexist in `services/` after the migration, and the folder layout tells you which is which:

1. **Suffix DI (clipboard, text, http, notifications, os, sound, download, analytics, blob-store, recorder)**: dual-impl, Vite picks the file at build time.
2. **Runtime DI (transcription, transformations, completion)**: one set of files, branches at call time on `settings.value`.
3. **Tauri-only**: not in `services/` anymore. Lives behind `$lib/tauri`, backed by `tauri.tauri.ts` and `tauri.browser.ts`.

## Migration plan

Six waves. Each is independently revertable.

### Wave 1: scaffold the new namespace

Create `apps/whispering/src/lib/tauri.tauri.ts` with one capability ported. Create `apps/whispering/src/lib/tauri.browser.ts` with `export const tauri = null;`. Don't touch any consumers yet. Verify both builds pass.

### Wave 2: migrate `transcribe.ts` to the namespace

Rewrite one shared consumer to `import { tauri } from '$lib/tauri'; if (tauri) { /* ... */ }`. This validates the consumer pattern with one capability.

### Wave 3: port the remaining six capabilities into `tauri.tauri.ts`

Move `fs`, `permissions`, `window`, `tray`, `globalShortcuts`, `autostart` from their old service files into sections of `tauri.tauri.ts`.

Delete the old `services/<cap>/` folders for these Tauri-only capabilities.

Delete `services/_tauri-stub.ts`.

### Wave 4: migrate web-bundled consumers

For each file that statically imports a former Tauri-only service, rewrite to use `import { tauri } from '$lib/tauri'`:

- `routes/(app)/+page.svelte` (fs for file-drop)
- `register-permissions.ts` (permissions)
- `macos-enable-accessibility/+page.{svelte,ts}` (permissions)
- `GlobalKeyboardShortcutRecorder.svelte` (global-shortcut-manager)

### Wave 5: migrate Tauri-only consumers (`rpc/desktop/*.tauri.ts`)

These files only run on Tauri builds, so they can statically import the non-null namespace from `$lib/tauri`. Pattern:

```ts
// rpc/desktop/fs.tauri.ts (hypothetical)
import { tauriOnly } from '$lib/tauri';

const { fs } = tauriOnly;
```

Delete `rpc/desktop/index.browser.ts` once the rpc adapters are all migrated.

### Wave 6: docs and cleanup

Update `apps/whispering/src/lib/services/README.md` to describe two patterns (suffix DI for dual-impl, runtime DI for user-pick) and link to this spec for the third (Tauri-only namespace, lives elsewhere). Update `ARCHITECTURE.md` to remove the Tauri-only stub explanation.

Add a short header comment to `tauri.tauri.ts` that links back to this spec so future readers can find the rationale.

## Why a single file instead of `lib/tauri/<cap>.ts` + barrel

A folder with per-capability files plus a `tauri.tauri.ts` barrel that re-imports them would work, but:

- The barrel becomes 7 lines of `import * as fs from './tauri/fs'` plus one composition line. Pure plumbing.
- "Adding a new Tauri capability" becomes two file edits (new file + barrel update) instead of one (new section in `tauri.tauri.ts`).
- The cohesion across the seven files is total: they all change when Tauri APIs change, they all bundle together, they share imports. Splitting them across files communicates independence they don't have.

The trigger to split would be either size (file passes ~500 lines) or genuine independent evolution (one capability gets a complex helper that doesn't belong with the others). Neither is true today. The single-file shape says "this is the Tauri bridge," which is the right level of abstraction.

## Why export `Tauri`?

The browser file doesn't need it. TypeScript's `moduleSuffixes` resolves consumer imports to `.tauri.ts` for type-checking, so the Tauri file's `export type Tauri = typeof tauriOnly` is the one source of truth. The browser file's `export const tauri = null` doesn't need any type information because TypeScript never looks at it for type resolution.

The type is still useful for shared helpers and components that accept a narrowed namespace as a parameter. Those call sites import `type Tauri` from `$lib/tauri` and keep browser files free of type plumbing.

## Runtime DI vs build-time DI vs namespace

Three patterns coexist after this migration:

| Pattern | File layout | Consumer pattern | Used for |
|---|---|---|---|
| **Build-time platform DI** | `services/<cap>/{index.tauri.ts, index.browser.ts}` | Plain static import | Genuinely dual-impl: clipboard, text, http, etc. |
| **Runtime DI** | `services/<cap>/<provider>.ts` + a switch | Switch reads `settings.value` at call time | User-selectable providers: transcription, transformations, completion |
| **Tauri namespace** | `lib/tauri.tauri.ts` + `tauri.browser.ts` with `tauri = null` | Shared code: `import { tauri } from '$lib/tauri'; tauri?.<cap>.method()`. Tauri-only files: `import { tauriOnly } from '$lib/tauri'` | Tauri-only capabilities |

The test for which pattern fits:

1. Does the answer change between web and desktop, but not between users? → build-time platform DI.
2. Does the answer change at runtime based on user settings? → runtime DI.
3. Is this only available on one platform with no fallback? → namespace.

## Risks

**1. The `Tauri | null` annotation is a stated lie in the Tauri file.** On Tauri builds, `tauri` is never `null` at runtime, but the type forces shared consumers to narrow. Some readers may find this annoying ("why am I optional-chaining when I'm only running on Tauri?"). The alternative (no `| null`) means web at runtime crashes when consumers forget to gate. The forced narrow trades a small ergonomic cost for build-time correctness. Documented in the spec; should be documented at the top of `tauri.tauri.ts`.

**2. Tauri-only code that imports from `$lib/tauri`** (like the new `rpc/desktop/*.tauri.ts` after Wave 5) should import `tauriOnly`. The browser file intentionally omits that export so accidental shared-code usage fails at build time.

**3. File size growth.** `tauri.tauri.ts` will be ~250 lines after the migration. If it grows past ~500 lines, the split-into-folder decision deserves a re-evaluation. The split is trivial to do later (each section becomes a file, the bottom of `tauri.tauri.ts` becomes a barrel). Not a one-way door.

**4. The `_tauri-stub.ts` + `unreachable` helper is deleted, but it might be useful elsewhere.** Specifically, the `unreachable: (...args: unknown[]) => never` trick could be useful for runtime-DI fallbacks. If we find a use case, re-add it at `lib/unreachable.ts`. Don't preserve it under the old name in `services/` purely for future-proofing.

## Open questions

1. **What belongs outside the namespace?** App-owned Rust commands live in `$lib/tauri/commands`, not in `tauri.tauri.ts`. That includes shell command execution and upload encoding.

2. **Naming: `globalShortcuts` vs `globalShortcutManager`?** The current folder is `services/global-shortcut-manager/`. Inside the namespace, the manager noun is redundant (everything in `tauri` is a manager of something). Lean: rename to `globalShortcuts` for brevity.

3. **Naming: `tauri?.fs.pathsToFiles` vs `tauri?.fs.FsServiceLive.pathsToFiles`?** The current Tauri-only services wrap their methods in a `XxxServiceLive` object (matching the dual-impl pattern). In the namespace, the extra wrapping is noise. Lean: drop the `XxxServiceLive` indirection; the namespace key (`fs`, `permissions`, ...) does the job that wrapping used to do.

## Estimated cost

Half a working day for the full migration. Each wave is small (~30 minutes to ~2 hours), reviewable in isolation, and revertable without touching adjacent waves.

## What this enables next

Once the namespace exists and the consumer pattern is established, two follow-ups become cleaner:

- **Tauri version checks.** If we ever need to gate on Tauri version (e.g., a capability only available in Tauri 2.5+), the namespace is the natural place to add a `version` field or feature flags.
- **Mock Tauri for tests.** A test harness can `vi.mock('$lib/tauri', () => ({ tauri: mockNamespace, tauriOnly: mockNamespace }))` once. Previously, mocking required mocking each `services/<cap>/index.tauri.ts` individually.

Neither is part of this spec. Both are cheaper after the migration than before it.
