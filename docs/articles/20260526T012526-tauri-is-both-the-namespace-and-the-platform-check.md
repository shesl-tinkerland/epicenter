# `tauri` is both the namespace and the platform check

Every Tauri-specific capability in Whispering lives under one namespace, exported as `tauri` from `$lib/tauri`. On Tauri builds it's the full namespace. On web builds it's `null`. Same name, same import path, different runtime value.

That two-state shape is the whole point. The variable doubles as a boolean: if `tauri` is truthy you're on Tauri, and you also have the capability surface in the same expression.

```ts
import { tauri } from '$lib/tauri';

if (tauri) {
  await tauri.fs.pathsToFiles(paths);
}
```

One check answers two questions. Two birds, one variable.

## What we were doing before

The pattern this replaces shows up in almost every desktop-flavored UI codebase. You check the platform, then you act on the platform. Two separate steps, two places to forget either half:

```ts
import { isTauri } from '@tauri-apps/api/core';
import { FsServiceLive } from '$lib/services/fs';

if (isTauri()) {
  await FsServiceLive.pathToBlob(path);
}
```

The `isTauri()` answers "am I on Tauri?" The `FsServiceLive` answers "what can I call?" They're the same question. The codebase had two ways to ask it because the platform check and the capability surface were declared in different files, with different stories about what happens on the wrong platform.

`FsServiceLive` on web was a stub object that threw when called. The throw was unreachable in practice (because `isTauri()` was false), but the import path resolved, the call site type-checked, and the developer had to remember to wrap every site in the guard. Forget the guard, and at runtime you'd get an error like "Tauri-only service called from web bundle" inside a `try`/`catch` somewhere downstream.

Two guards for one fact. Either one alone would compile.

## The collapse

The namespace fixes both halves at once. The capability is `null` on web, so there's nothing to call. The platform check is the truthiness of `tauri`, so it's the same expression. If you forget the check, TypeScript catches you:

```ts
import { tauri } from '$lib/tauri';

await tauri.fs.pathsToFiles(paths);
//    ^ 'tauri' is possibly 'null'.
```

You can't write the unsafe version. The type forces you to narrow.

The narrowing then gives you both: you're on Tauri AND `tauri` is the namespace.

```ts
if (tauri) {
  // here, `tauri` is the full namespace, not `null`
  await tauri.fs.pathsToFiles(paths);
  await tauri.autostart.enable();
}
```

Inside the `if`, every capability is reachable without re-checking. The branch is the boundary.

## How it's two files behind one import

Vite swaps the file at build time. `tauri.tauri.ts` is the real namespace. `tauri.browser.ts` is the web stub:

```ts
export const tauri = null;
```

The `tauri` export is the platform check. The non-null `tauriOnly` export exists only in `tauri.tauri.ts`, so `.tauri.ts` files can import it directly and browser-bundled misuse fails at build time.

`vite.config.ts` has:

```ts
resolve: {
  extensions: isTauri
    ? ['.tauri.ts', '.ts']
    : ['.browser.ts', '.ts'],
}
```

On Tauri builds, `import { tauri } from '$lib/tauri'` resolves to `tauri.tauri.ts`. On web, it resolves to `tauri.browser.ts`. The non-target file isn't bundled.

TypeScript needs the same trick for type-checking. `tsconfig.json`:

```json
"moduleSuffixes": [".tauri", ".browser", ""]
```

TS always reads `tauri.tauri.ts` for type information, regardless of build. The Tauri file exports the shape; the browser file just has to match at runtime.

So the consumer sees one type (`Tauri | null`) on both builds, and the runtime value follows the platform.

## Pushing the narrowing further: prop drilling

After you narrow `tauri` once, code below that point shouldn't have to re-narrow. The check has already happened. Pass the non-null reference down.

This works two ways, depending on whether you're crossing a component boundary or a function boundary.

### Component-level: Svelte props

```svelte
<!-- settings/shortcuts/global/+page.svelte -->
<script>
  import { tauri } from '$lib/tauri';
  import ShortcutTable from '../keyboard-shortcut-recorder/ShortcutTable.svelte';
</script>

{#if tauri}
  {@const t = tauri}
  <ShortcutTable type="global" tauri={t} />
{/if}
```

```svelte
<!-- ShortcutTable.svelte -->
<script lang="ts">
  import type { Tauri } from '$lib/tauri';
  import GlobalKeyboardShortcutRecorder from './GlobalKeyboardShortcutRecorder.svelte';

  let { type, tauri }: { type: 'local' | 'global'; tauri?: Tauri } = $props();
</script>

{#if type === 'local'}
  <LocalKeyboardShortcutRecorder />
{:else if tauri}
  <GlobalKeyboardShortcutRecorder {tauri} />
{/if}
```

The global shortcuts page binds `{@const t = tauri}` inside the `{#if tauri}` block, then passes that non-null value into the table. The table only forwards it into the global recorder after another local narrow. No re-check inside the recorder, no `tauri?.`, no assertion.

### Function-level: positional parameter

The same idea works for plain functions. If a helper is only meaningful when Tauri is present, take `tauri: Tauri` as an argument instead of re-narrowing inside.

Before (the helper re-narrows what its caller already checked):

```ts
// syncIconWithRecorderState.svelte.ts
import { tauri } from '$lib/tauri';

export function syncIconWithRecorderState() {
  $effect(() => {
    void tauri?.tray.setIcon({ icon: manualRecorder.state });
    //       ^ redundant: caller already gated on `if (tauri)`
  });
}
```

```svelte
<!-- AppLayout.svelte (caller, before) -->
<script>
  import { tauri } from '$lib/tauri';
  import { syncIconWithRecorderState } from './syncIconWithRecorderState.svelte';

  if (tauri) {
    syncIconWithRecorderState(); // narrow happens, but the function doesn't know
  }
</script>
```

After (helper accepts the asserted namespace; the redundant narrow disappears):

```ts
// syncIconWithRecorderState.svelte.ts
import type { Tauri } from '$lib/tauri';

export function syncIconWithRecorderState(tauri: Tauri) {
  $effect(() => {
    void tauri.tray.setIcon({ icon: manualRecorder.state });
  });
}
```

```svelte
<!-- AppLayout.svelte (caller, after) -->
<script>
  import { tauri } from '$lib/tauri';
  import { syncIconWithRecorderState } from './syncIconWithRecorderState.svelte';

  if (tauri) {
    syncIconWithRecorderState(tauri); // narrowed value flows through
  }
</script>
```

The function signature is the documentation: "I need Tauri." TypeScript enforces it. Callers without a narrowed `tauri` in scope get a compile error, which is exactly the feedback you want.

### Why the prop-drill instead of `tauriOnly`?

The narrowing is already in your hand at the call site. You have the value. Passing the value you already have is more honest than asking a helper to import a Tauri-only module export. The signature ends up self-documenting: `(tauri: Tauri)` literally says "this function needs Tauri" in the place a reader looks first.

Use `tauriOnly` only when prop-drilling doesn't make sense, typically because the caller boundary is the build system itself rather than another piece of your code.

### Where this composes

Any helper or component that needs Tauri capabilities declares it in its signature. Parents either have a narrowed `tauri` to pass, or they themselves need to gate before rendering, or they take a `Tauri` prop from their own parent. The invariant climbs the tree until it hits the one place that did `if (tauri)`. That one check is the boundary; everything below it is unconditionally Tauri-shaped.

## `tauriOnly` for files the build system already gated

There's one case where the prop-drill doesn't fit cleanly: code that lives in a `*.tauri.ts` file. The Vite suffix routing already guarantees the module is only loaded on Tauri builds, so there isn't a caller boundary you can prop-drill from. Yet inside the file, `import { tauri } from '$lib/tauri'` still gives you `Tauri | null`, because TypeScript reads the same nullable shape for both builds.

The historical workaround was a non-null assertion at the top of the file:

```ts
// file-system.tauri.ts (old)
import { tauri } from '$lib/tauri';
// This file is Tauri-only (suffix `.tauri.ts` keeps it out of web bundles),
// so `tauri` is never null when this module loads.
const { fs } = tauri!;
```

That `tauri!` is fine but ugly: it asserts a fact the filename already encodes. The fact is encoded twice, in two different syntaxes, in two different files. If someone ever imports this from a non-`.tauri.ts` file, the assertion silently lies and you crash with a confusing null property access elsewhere.

The replacement is a named export from the same `$lib/tauri` module:

```ts
// file-system.tauri.ts (new)
import { tauriOnly } from '$lib/tauri';

const { data: files } = await tauriOnly.fs.pathsToFiles(paths);
```

`tauriOnly` is a `Tauri` (non-null) namespace on Tauri builds. The browser shim does not export it. If anyone imports it from shared code that reaches the web bundle, the browser build fails instead of shipping a runtime assertion.

The naming carries the constraint. Reviewers see `tauriOnly` and know this code must live behind a Tauri-only build boundary.

### When to use which

A short rule:

- **Crossing a function or component boundary inside shared code?** Prop-drill `tauri: Tauri`. The narrow has happened in the caller; pass the value.
- **Top of a `.tauri.ts` file that needs the namespace?** `tauriOnly`. The build system is your guarantee; the import names that fact directly.
- **Plain shared code that may or may not be on Tauri?** Narrow at the call site (`if (tauri)` or `tauri?.`). The runtime ambiguity is real and the narrow is doing real work.

## When this doesn't fit: dual-implementation services

The namespace is for things that exist ONLY on Tauri. Some services exist on BOTH platforms with real implementations on each. Clipboard. Text. HTTP. Notifications. The web version reads `navigator.clipboard`, the Tauri version uses `@tauri-apps/plugin-clipboard-manager`.

Those don't go in the namespace. They get their own folder with `index.tauri.ts` and `index.browser.ts` files that both implement a shared interface:

```ts
// services/clipboard/index.browser.ts
import type { ClipboardService } from './types';

export const ClipboardServiceLive = {
  writeText: async (text) => navigator.clipboard.writeText(text),
} satisfies ClipboardService;
```

Consumer code doesn't know or care which version it gets:

```ts
import { ClipboardServiceLive } from '$lib/services/clipboard';
await ClipboardServiceLive.writeText('hello');
```

No `tauri?.` here. The whole point is that the capability exists on both platforms; the implementation differs but the call site doesn't. We covered this pattern in [Two files, one import](./20260525T234034-two-files-one-import-build-time-platform-injection.md).

The test for which pattern fits:

- **Capability exists on both, with different implementations?** Suffix DI. `services/<cap>/index.{tauri,browser}.ts`, shared interface, single consumer pattern.
- **Capability only exists on Tauri?** Namespace. `$lib/tauri` with `if (tauri)` or `tauri?.` at consumers.

Most apps want both patterns. They solve different problems.

## What lives in `tauri`

Today: file import helpers, macOS permission flows, window control, system tray, global shortcuts, autostart. Each leaf picks one canonical call form. Autostart uses TanStack because the settings UI observes and invalidates it; tray, shortcuts, fs, and window are plain Result-returning functions. App-owned Rust commands, including accessibility settings and upload encoding, live in `$lib/tauri/commands`. There is no `tauri.rpc` sub-namespace any more.

Adding a new Tauri-only capability is one section in one file:

```ts
// tauri.tauri.ts
export const NewCapError = defineErrors({ ... });

const newCap = {
  doSomething: (arg: string) => tryAsync({ ... }),
};

const _tauri = {
  fs, permissions, /* ... */, newCap,
};
```

Consumers immediately see `tauri?.newCap.doSomething(arg)` with full type-checking. The web build doesn't ship any of the new code; on web, `tauri` is still just `null`.

## The thing I keep coming back to

The reason this pattern feels right is that the platform check and the capability surface stop being two separate concepts. They were already the same concept: "Tauri exists, and these are the things you can do with it." We used to spell them in two different files with two different import paths. Now they're one variable, and the question "should I do this on Tauri?" is the same question as "can I do this at all?"

The TypeScript narrowing gives us the rest for free. You can't call into the namespace without first asking the platform question, because the question and the answer are the same expression.

## If you want to see the code

- `apps/whispering/src/lib/tauri.tauri.ts` is the namespace.
- `apps/whispering/src/lib/tauri.browser.ts` is the web stub (`tauri = null`; no `tauriOnly` export).
- `apps/whispering/vite.config.ts` for the build-time switch.
- `apps/whispering/tsconfig.json` for `moduleSuffixes`.
- Any consumer file under `apps/whispering/src/routes/` for a real call site.

Fork it, break it, ship your own version. The whole pattern is about 50 lines of code plus one Vite config line.
