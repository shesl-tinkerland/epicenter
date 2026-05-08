# Workspace gate forget-device recovery

**Date**: 2026-05-07
**Status**: Implemented
**Author**: AI-assisted
**Branch**: chore/workspace-app-layout-skill-audit

## One-sentence thesis

`WorkspaceGate` handles local workspace boot failure with reload as a safe retry, forget-device as the local repair, and sign-out as an auth escape hatch.

## Overview

This spec changes the shared workspace-load failure UI so it treats `idb.whenLoaded` failures as local persistence failures, not auth failures. The target behavior is `wipe() + reload` for "Forget this device", with "Reload" as the safe retry and "Sign out" as a secondary account escape hatch.

## Motivation

### Current state

`WorkspaceGate` is a shared Svelte gate around a caller-provided promise:

```svelte
<WorkspaceGate
	pending={current.signedIn.honeycrisp.idb.whenLoaded}
	onSignOut={() => auth.signOut()}
>
	<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>
</WorkspaceGate>
```

The default error branch currently offers reload and optional sign-out:

```svelte
<Empty.Title>Failed to load workspace</Empty.Title>
<Empty.Description>
	{err instanceof Error ? err.message : 'The workspace could not be opened.'}
</Empty.Description>
<Button variant="outline" onclick={() => window.location.reload()}>
	Reload
</Button>
{#if onSignOut}
	<Button onclick={onSignOut}>Sign out</Button>
{/if}
```

Signed-in account menus already expose "Forget this device" as a local data repair action:

```ts
async function forgetHoneycrispDevice(): Promise<void> {
	await signedIn.honeycrisp.wipe();
	window.location.reload();
}
```

Browser workspace bundles already make the distinction explicit:

```ts
return {
	...doc,
	idb,
	sync,
	async wipe() {
		noteBodyDocs[Symbol.dispose]();
		doc[Symbol.dispose]();
		await Promise.all([idb.whenDisposed, sync.whenDisposed]);
		await wipeOwnerLocalYjsData({ userId, ydocGuids: fallbackGuids });
	},
	[Symbol.dispose]() {
		noteBodyDocs[Symbol.dispose]();
		doc[Symbol.dispose]();
	},
};
```

This creates problems:

1. **Wrong primary repair**: `idb.whenLoaded` failures are mostly local persistence, decryption, or malformed persisted update failures. `auth.signOut()` does not delete or repair the broken IndexedDB data.
2. **Mixed semantics**: `AccountPopover` treats "Forget this device" as the local data action, while `WorkspaceGate` treats "Sign out" as the only non-reload recovery action.
3. **Zhongwen outlier**: Zhongwen's page-level forget-device flow currently calls `await signedIn.zhongwen.wipe(); await auth.signOut();`. That conflates local repair with auth exit.
4. **Poor user model**: A user who signs out and signs back in may hit the same failed local cache again. A user who forgets the device gets a clean local open.

### Desired state

`WorkspaceGate` should render recovery actions that match the layer that failed:

```txt
Failed to load workspace

Primary retry:
  Reload

Primary repair:
  Forget this device

Secondary escape:
  Sign out
```

Apps wire the repair action by composing their signed-in bundle's `wipe()` with a reload:

```svelte
<WorkspaceGate
	pending={current.signedIn.fuji.idb.whenLoaded}
	onForgetDevice={async () => {
		await current.signedIn.fuji.wipe();
		window.location.reload();
	}}
	onSignOut={() => auth.signOut()}
>
	<FujiAppShell>{@render children?.()}</FujiAppShell>
</WorkspaceGate>
```

The important boundary is this:

```txt
Sign out: stop using this auth session.
Forget this device: delete owner-scoped local workspace persistence, then reload.
```

## Research findings

### Local workspace boot

The gate promise is `bundle.idb.whenLoaded`. For encrypted IndexedDB persistence, `whenLoaded` resolves after the provider opens the database, reads encrypted updates, decrypts them, and applies them to the Y.Doc.

The rejection path is local:

```ts
dbPromise
	.then(async (openedDb) => {
		db = openedDb;
		await fetchUpdates(...);
	})
	.catch((error: unknown) => {
		rejectLoaded(error);
	});
```

`fetchUpdates()` can fail while reading IndexedDB, decrypting persisted updates, applying Yjs updates, or discovering missing stores. Those are not repaired by changing auth state.

**Key finding**: `WorkspaceGate` is waiting on local persistence readiness, not remote sync and not Better Auth session validation.

**Implication**: The default recovery should target local persistence before auth.

### Existing browser bundle contract

The workspace lifecycle specs already separate two verbs:

```txt
Symbol.dispose: stop the live runtime and preserve local data.
wipe(): stop the live runtime, await disposal barriers, delete local persistence.
```

That is the right primitive for this recovery. The gate should not call `idb.clearLocal()` directly, because root documents, child documents, sync handles, and owner-scoped names are bundle-specific.

**Key finding**: `wipe()` is the bundle-level local repair primitive.

**Implication**: `WorkspaceGate` should receive `onForgetDevice`, not a lower-level `clearLocal` or `idb` handle.

### Existing auth contract

`auth.signOut()` calls Better Auth's sign-out endpoint and then clears the local auth credential/state. `createSession()` reacts by disposing the signed-in payload.

That is correct for leaving the account. It is not a local workspace repair. The sign-out preservation spec already settled the product boundary:

```txt
Sign-out destroys the live workspace and reloads; sign-in opens only the local cache scoped to that authenticated owner.
```

**Key finding**: ordinary sign-out should not wipe owner-scoped local workspace data.

**Implication**: `WorkspaceGate` should keep sign-out available, but it should not present it as the default fix for a workspace-open failure.

### Current app surface

Current consumers:

| App | Gate awaits | Current gate action | Existing forget-device action |
| --- | --- | --- | --- |
| Fuji | `current.signedIn.fuji.idb.whenLoaded` | `onSignOut` | `signedIn.fuji.wipe(); reload()` in `AppHeader` |
| Honeycrisp | `current.signedIn.honeycrisp.idb.whenLoaded` | `onSignOut` | `signedIn.honeycrisp.wipe(); reload()` in `Sidebar` |
| Opensidian | `current.signedIn.opensidian.idb.whenLoaded` | `onSignOut` | `forgetOpensidianDevice()` wipes then reloads |
| Zhongwen | `current.signedIn.zhongwen.idb.whenLoaded` | `onSignOut` | Page action wipes then signs out |

**Key finding**: three apps already model forget-device as wipe plus reload. Zhongwen is the outlier.

**Implication**: Standardize Zhongwen to wipe plus reload, then wire the same callback into each gate.

## Design decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Primary repair for workspace-load failure | 1 evidence | Forget this device | The failed promise is `idb.whenLoaded`; `wipe()` deletes the owner-scoped local persistence that can make the promise reject. |
| Safe retry | 2 coherence | Keep Reload | Reload handles transient browser/storage failures and costs nothing before destructive repair. |
| Auth escape hatch | 2 coherence | Keep Sign out as secondary | Auth exit remains useful for account switching or suspicion of session mismatch, but it should not be framed as the repair. |
| Destructive confirmation | 2 coherence | Confirm before calling `onForgetDevice` | Forget-device deletes local data and can lose unsynced edits. It needs the same confirmation standard as `AccountPopover`. |
| Gate API shape | 2 coherence | Add `onForgetDevice?: () => void | Promise<void>` | The gate owns UI state; the app owns the bundle and knows how to wipe it. |
| Lower-level clear API | 2 coherence | Do not pass `idb` or `clearLocal` to `WorkspaceGate` | Bundle `wipe()` knows root docs, child docs, disposal barriers, and owner-scoped cleanup. |
| Zhongwen forget flow | 2 coherence | Change wipe plus sign-out to wipe plus reload | Aligns with the meaning of "Forget this device" and keeps sign-out independent. |
| Button ordering | 3 taste | Reload, Forget this device, Sign out | Puts safe retry first, real repair second, auth escape last. Revisit if user testing shows people skip reload and expect one obvious primary action. |

## Architecture

The shared gate stays a render gate. It does not become an auth or workspace lifecycle owner.

```txt
layout.svelte
  reads session.current
  passes:
    pending: signedIn.<workspace>.idb.whenLoaded
    onForgetDevice: app callback
    onSignOut: auth callback
    children: app UI

WorkspaceGate
  awaits pending
  renders children after local persistence loads
  on rejection:
    shows error
    Reload: window.location.reload()
    Forget this device: confirmation, await onForgetDevice()
    Sign out: await onSignOut()

browser workspace bundle
  wipe()
    dispose child caches
    destroy root doc
    await idb/sync whenDisposed barriers
    delete owner-scoped local Yjs databases
```

Flow:

```txt
STEP 1: Workspace load fails
----------------------------
`idb.whenLoaded` rejects while opening, decrypting, or applying local
workspace updates.

STEP 2: User retries
--------------------
Reload refreshes the page and rebuilds the same signed-in workspace from
the same local cache.

STEP 3: User repairs local data
-------------------------------
Forget this device asks for confirmation, calls the app's `wipe()`, and
reloads into a clean local workspace for the same signed-in user.

STEP 4: User exits auth
-----------------------
Sign out clears the auth session. It does not claim to fix local workspace
persistence.
```

## API design

### WorkspaceGate props

Current:

```ts
type WorkspaceGateProps = {
	pending: Promise<unknown>;
	children: Snippet;
	loading?: Snippet;
	error?: Snippet<[unknown]>;
	onSignOut?: () => void;
};
```

Target:

```ts
type WorkspaceGateProps = {
	pending: Promise<unknown>;
	children: Snippet;
	loading?: Snippet;
	error?: Snippet<[unknown]>;
	onForgetDevice?: () => void | Promise<void>;
	onSignOut?: () => void | Promise<void>;
};
```

The default error branch should own the confirmation copy and pending state for forget-device. Apps can still override the whole error branch if they need different recovery.

Suggested copy:

```txt
Title:
Failed to load workspace

Description:
The workspace could not be opened from local data on this device.

Forget confirmation title:
Forget this device?

Forget confirmation description:
This deletes local workspace data for this account on this device. Synced data stays in your account, but unsynced local changes may be lost.

Confirm button:
Forget device
```

If the original error is an `Error`, keep showing `err.message` as secondary diagnostic text if the existing `Empty.Description` pattern has room. Do not replace the layer-specific explanation with a raw technical message only.

## Implementation plan

### Phase 1: Shared gate API

- [x] **1.1** Update `packages/svelte-utils/src/workspace-gate/workspace-gate.svelte` props to add `onForgetDevice?: () => void | Promise<void>` and allow async `onSignOut`.
  > **Note**: Used `() => unknown` for both `onForgetDevice` and `onSignOut` instead of `() => void | Promise<void>`. Reason: existing callers pass `() => auth.signOut()` which returns `Promise<Result<undefined, AuthError>>`. The original `() => void` accepted any return because of TypeScript's special handling of `void`, but the union `void | Promise<void>` does not. `() => unknown` keeps the same caller flexibility while still being awaited internally.
- [x] **1.2** Add local `forgettingDevice` and `signingOut` state so buttons can disable while their async actions run.
- [x] **1.3** Import and use `confirmationDialog` from `@epicenter/ui/confirmation-dialog` for the forget-device action.
- [x] **1.4** Keep `Reload` as the safe retry.
- [x] **1.5** Render `Forget this device` only when `onForgetDevice` is provided.
- [x] **1.6** Render `Sign out` only when `onSignOut` is provided, visually secondary to forget-device.
  > **Note**: Sign out uses `variant="ghost"` after the destructive Forget device button, making it visually subordinate.
- [x] **1.7** Preserve `loading` and `error` snippet overrides unchanged.
- [x] **1.8** Update the component JSDoc/example so it shows `onForgetDevice` and describes sign-out as secondary.

### Phase 2: App wiring

- [x] **2.1** In `apps/fuji/src/routes/+layout.svelte`, pass `onForgetDevice={async () => { await current.signedIn.fuji.wipe(); window.location.reload(); }}` to `WorkspaceGate`.
- [x] **2.2** In `apps/honeycrisp/src/routes/+layout.svelte`, pass `onForgetDevice` using `current.signedIn.honeycrisp.wipe()`.
- [x] **2.3** In `apps/opensidian/src/routes/+layout.svelte`, pass `onForgetDevice` using `opensidian.wipe()`.
  > **Note**: Opensidian uses a module-level `opensidian` import, not `current.signedIn.opensidian` — the layout already imported `opensidian` from `$lib/opensidian/client`. Same end result.
- [x] **2.4** In `apps/zhongwen/src/routes/(signed-in)/+layout.svelte`, pass `onForgetDevice` using `current.signedIn.zhongwen.wipe()`.
- [x] **2.5** Keep `onSignOut={() => auth.signOut()}` in all four gates, but rely on the new UI ordering and copy to make it secondary.

### Phase 3: Zhongwen normalization

- [x] **3.1** Change `apps/zhongwen/src/routes/(signed-in)/+page.svelte` forget-device confirmation to `await signedIn.zhongwen.wipe(); window.location.reload();`.
  > **Note**: N/A. The offending `wipe(); signOut();` flow no longer exists in `apps/zhongwen/src/routes/(signed-in)/+page.svelte` (likely removed in commit `41feaa1b7 refactor: remove device reset from account menu`). The page has no forget-device action to normalize.
- [x] **3.2** Remove `await auth.signOut()` from that forget-device flow.
  > **Note**: N/A; nothing to remove.
- [x] **3.3** If Zhongwen still needs an explicit sign-out action, add it separately with copy that says "Sign out".
  > **Note**: N/A. Sign-out remains available through the gate's secondary `onSignOut` button.

### Phase 4: Consistency audit

- [x] **4.1** Search for `await .*\\.wipe\\(\\);\\s*await auth.signOut` and replace any local-repair flows with wipe plus reload unless the code is explicitly an auth-exit flow.
  > **Note**: No matches in `apps/` or `packages/` UI code outside of the gate's JSDoc example.
- [x] **4.2** Search for `onSignOut={() => auth.signOut()}` on `WorkspaceGate` and verify each signed-in workspace gate also passes `onForgetDevice`.
  > **Note**: All four gates (Fuji, Honeycrisp, Opensidian, Zhongwen) now pass `onForgetDevice`.
- [x] **4.3** Search for `idb.clearLocal()` in app UI. UI should prefer bundle `wipe()` unless it is an attachment-level test or low-level workspace utility.
  > **Note**: Only call sites are inside bundle `wipe()` implementations (`apps/skills/src/lib/skills/browser.ts`) and tests. No UI-level callers.
- [x] **4.4** Re-read `AccountPopover` and `WorkspaceGate` copy together. They should describe forget-device the same way.
  > **Note**: `AccountPopover` does not currently expose a forget-device action (it was removed in `41feaa1b7 refactor: remove device reset from account menu`). The gate now owns the forget-device copy.

### Phase 5: Verification

- [x] **5.1** Run `bun run check` or the repo's nearest typecheck command for affected packages/apps.
  > **Note**: Used `bun run typecheck` (the repo's actual script). Honeycrisp clean (0 errors). Fuji's only error is pre-existing in `EntriesTable.svelte`, unrelated. `@epicenter/svelte` shows 4 newly-traced errors about `#/utils.js` etc. inside `confirmation-dialog.svelte`, but these are a pre-existing svelte-check path-resolution issue with `imports` field across packages (the same kind already produced 28 errors before my change). Runtime imports work.
- [x] **5.2** Run focused tests for `packages/auth`, `packages/svelte-utils`, and workspace wipe tests if they exist.
  > **Note**: No tests exist for `packages/svelte-utils/workspace-gate`. Workspace wipe behavior is unchanged. Skipped.
- [ ] **5.3** Use browser smoke testing for at least Fuji or Honeycrisp: force a rejected `pending` promise or temporarily pass `Promise.reject(new Error('test'))` to verify action layout and confirmation behavior.
  > **Note**: Deferred to manual smoke. The change is structural and visible only on a rejected `idb.whenLoaded` path.
- [ ] **5.4** Verify that normal account-menu sign-out still signs out without wiping local data.
  > **Note**: Deferred to manual smoke. This spec did not modify account-menu sign-out semantics.

## Edge cases

### Wipe fails

1. User clicks "Forget this device".
2. Confirmation runs `onForgetDevice()`.
3. `wipe()` rejects.

Expected: keep the user on the error screen, re-enable actions, and show a toast or visible error. Do not sign out as a fallback, because that can leave the broken local cache in place.

### Reload succeeds after transient failure

1. `idb.whenLoaded` rejects because the browser transiently failed to open IndexedDB.
2. User clicks Reload.
3. The next boot opens successfully.

Expected: no local data is deleted.

### User wants to switch accounts

1. Workspace load fails.
2. User clicks Sign out.
3. Auth session clears.

Expected: local data remains owner-scoped and preserved. If the user signs back into the same account, the same local failure may remain. That is acceptable because sign-out was an auth exit, not a local repair.

### Unsynced local changes

1. Local data contains edits that never reached the server.
2. Workspace load fails before the app can inspect sync status.
3. User chooses Forget this device.

Expected: confirmation copy warns that unsynced local changes may be lost. Do not claim synced data is guaranteed unless the app has proven it.

### Child document caches

1. Workspace has child documents persisted in separate IndexedDB databases.
2. User chooses Forget this device.
3. Bundle `wipe()` computes fallback child GUIDs and calls `wipeOwnerLocalYjsData`.

Expected: the gate never calls `idb.clearLocal()` directly. Bundle `wipe()` remains the only UI-level deletion primitive.

## Open questions

1. **Should `WorkspaceGate` own toast-on-error for failed forget-device?**
   - Options: (a) import `toast` and show a shared message, (b) require app callbacks to handle errors, (c) display an inline error in the gate.
   - **Recommendation**: use shared toast in `WorkspaceGate`. The gate owns the destructive action state once it owns the confirmation.

2. **Should the destructive repair button be visually primary?**
   - Options: (a) `variant="destructive"` after Reload, (b) `variant="outline"` with destructive text, (c) hide it behind an overflow menu.
   - **Recommendation**: use `variant="destructive"` after Reload. It is the real repair, but confirmation prevents accidental deletion.

3. **Should `WorkspaceGate` accept a custom forget-device description?**
   - Options: (a) generic copy only, (b) `forgetDeviceDescription?: string`, (c) require full `error` snippet override.
   - **Recommendation**: generic copy only for now. Full `error` override already exists for apps that need special language.

4. **Should sign-out reload after success?**
   - Options: (a) rely on auth state and `createSession` disposal, (b) reload after sign-out, (c) let each app decide.
   - **Recommendation**: leave existing app behavior unchanged in this spec. This spec is about failed workspace load recovery, not ordinary sign-out lifecycle.

## Decisions log

- Keep `WorkspaceGate` as a shared component: four current consumers have the same load/error shape and snippet overrides already exist. Revisit when an app needs materially different gate chrome that cannot be expressed with the `error` snippet.
- Keep sign-out in the gate error branch: account switching remains a legitimate escape hatch. Revisit if users repeatedly choose it expecting local repair.
- Keep Reload first: it is the least destructive action. Revisit if the UI needs a single emphasized recovery action.

## Success criteria

- `WorkspaceGate` no longer presents sign-out as the only non-reload default recovery.
- Every signed-in workspace layout that uses `WorkspaceGate` can pass `onForgetDevice`.
- Forget-device means `await workspace.wipe(); window.location.reload();` across Fuji, Honeycrisp, Opensidian, and Zhongwen.
- Zhongwen no longer signs out as part of forget-device.
- Ordinary sign-out still preserves owner-scoped local data.
- No UI-level code calls attachment `clearLocal()` when bundle `wipe()` is available.

## Review

**Completed**: 2026-05-08
**Branch**: chore/workspace-app-layout-skill-audit

### Summary

Added `forgetDevice` and `signOut` props to `WorkspaceGate` and wired them into Fuji, Honeycrisp, Opensidian, and Zhongwen layouts. The error branch now offers Reload (outline), Forget this device (destructive, with confirmation dialog), and Sign out (ghost) in that order. The forget-device action confirms with shared copy, calls the injected `wipe()` primitive, then reloads (the gate owns the reload). Failures surface via a toast without changing auth state. Sign-out delegates to the injected primitive; post-sign-out behavior remains owned by the auth/session reactor.

### Deviations from Spec

- **Prop shape and naming**: the spec proposed `onForgetDevice?: () => void | Promise<void>` and `onSignOut?: () => void | Promise<void>` as event-handler callbacks where each app composes the full action. After implementing it that way (committed in `1688ac5dc`), we reviewed the result: every consumer wrote the same `await wipe(); window.location.reload();` block. We refactored to dependency-injection naming, `forgetDevice?: () => unknown` and `signOut?: () => unknown`, with the gate composing the reload. The new shape:
  - matches the gate's UI promise (button label "Forget this device" now actually deletes data and reopens, not whatever the app decided to do)
  - collapses 4-line callbacks at every call site to single-line value injections
  - reads symmetrically (both props are "primitives the gate composes") with the asymmetric post-step (gate reloads after `forgetDevice`; auth reactor handles post-`signOut`) documented in JSDoc rather than encoded in prop names
  - drops the `on` prefix for both, since the gate is composition-shaped, not event-source-shaped
- **Callback return type**: used `() => unknown` instead of `() => void | Promise<void>`. The spec's union type rejected existing callers like `() => auth.signOut()` whose return is `Promise<Result<undefined, AuthError>>`. The original `() => void` worked only because of TypeScript's special-case acceptance of any return for `void`-returning function types; the union loses that. `() => unknown` keeps caller flexibility and is awaited internally.
- **Phase 3 (Zhongwen normalization) was a no-op**: the offending `wipe(); signOut();` flow on `apps/zhongwen/src/routes/(signed-in)/+page.svelte` no longer exists. It was already removed (likely in `41feaa1b7`). The spec was accurate at draft time but stale at execution.
- **Open question 1 resolved as recommended**: the gate owns toast-on-error for `forgetDevice` failures via `toast.error(...)`.
- **Open question 2 resolved as recommended**: Forget-device button uses `variant="destructive"`; Sign out uses `variant="ghost"` for visual subordination.
- **Phase 5.3 / 5.4 manual smoke deferred**: this work is structural; the failure path requires a deliberately broken IndexedDB and was not exercised in this run.

### Follow-up Work

- The pre-existing svelte-check `#*` import resolution issue across the @epicenter/ui package boundary should be addressed at the tooling level. My change newly traces 4 of those errors into `@epicenter/svelte`'s typecheck because `confirmation-dialog.svelte` is a new transitive dependency of `workspace-gate.svelte`. The errors are not introduced by my code, but the resolution issue makes downstream consumers noisier.
- A failing-promise smoke test for `WorkspaceGate` would be a useful guard (it could mount the gate with `Promise.reject(new Error('boom'))` and assert the three buttons render with the right labels and disable while pending).
