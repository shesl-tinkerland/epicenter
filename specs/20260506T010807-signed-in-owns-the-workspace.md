# Signed-In Owns the Workspace

> The workspace is a field of the signed-in auth state, not a parallel cell. One source of truth, one transition, one subscription.

## Problem

`apps/fuji/src/lib/workspace.ts` and `apps/fuji/src/lib/components/FujiWorkspaceProvider.svelte` keep three mutable cells in sync to express one invariant.

```txt
"is the user signed in?"        auth.state                 (real cell)
"is the workspace attached?"    workspace.ts fujiInstance  (mirror cell)
"is the entries delegate up?"   entries-state.svelte.ts    (mirror cell)
```

The provider exists only to keep the second and third cells synchronized with the first. That synchronization is its entire job. The Proxy in `workspace.ts`, the `protectedAuth.identity` getter, the `entriesState` two-layer delegate, the `disposeFuji` HMR hook, the `auth.onStateChange` handler inside the provider, and the `{#key identity.user.id}` remount: every one of those exists to compensate for the same missing invariant.

The product sentence is one line:

> In Fuji, the workspace exists exactly when a user is signed in.

The current code says it with three cells. It should say it with one.

## Asymmetric Win

Refuse the option of "signed-in without workspace" and "workspace without signed-in." Make the workspace a field of the signed-in variant of the session state. Workspace lifecycle becomes a side effect of the auth transition, owned by the layer that already owns "is the user signed in?"

```txt
Product sentence:
  In Fuji, the workspace exists exactly when a user is signed in.

Candidate refusal:
  The "signed-in but workspace not yet attached" intermediate state.
  The "workspace attached but auth signed-out" intermediate state.

Code family it deletes:
  - apps/fuji/src/lib/workspace.ts (Proxy, fujiInstance cell, getFujiInstance, disposeFuji, HMR dispose)
  - apps/fuji/src/lib/entries-state.svelte.ts (entriesState wrapper, getDelegate, two-layer destroy)
  - apps/fuji/src/lib/components/FujiWorkspaceProvider.svelte (entire file: lifecycle role)
  - apps/fuji/src/lib/auth.ts protectedAuth getter
  - {#key protectedAuth.identity.user.id} in +layout.svelte
  - The onStateChange handler that reloads on identity change

User loss:
  - Workspace constructs eagerly on sign-in instead of lazily on first access. Lazy was buying nothing; UI reads it immediately.
  - No caller in Fuji ever wanted "auth identity without workspace." The intermediate state was never useful.

Decision:
  Refuse. The deletion is large, the loss is fictional.
```

## Architecture

### Session as a discriminated union

```ts
// $lib/session.svelte.ts
export type Session =
  | { status: 'pending' }
  | { status: 'signed-out' }
  | {
      status: 'signed-in';
      identity: AuthIdentity;
      fuji: Fuji;
    };
```

`fuji` is a field of the `signed-in` variant. There is no path in TypeScript to read `fuji` without first proving you are signed-in. The invariant is in the type.

### One subscription owns transitions

```ts
// $lib/session.svelte.ts
function createSession() {
  const state = $state<Session>({ status: 'pending' });

  auth.onStateChange((next) => {
    if (next.status === 'pending') {
      Object.assign(state, { status: 'pending' });
      return;
    }
    if (next.status === 'signed-out') {
      if (state.status === 'signed-in') state.fuji[Symbol.dispose]();
      Object.assign(state, { status: 'signed-out' });
      return;
    }
    // signed-in
    if (state.status === 'signed-in') {
      if (state.identity.user.id === next.identity.user.id) {
        state.fuji.encryption.applyKeys(next.identity.encryptionKeys);
        return;
      }
      state.fuji[Symbol.dispose]();
    }
    Object.assign(state, {
      status: 'signed-in',
      identity: next.identity,
      fuji: openFuji({
        identity: next.identity,
        peer: { id: getOrCreateInstallationId(localStorage), name: 'Fuji', platform: 'web' },
        bearerToken: () => auth.bearerToken,
      }),
    });
  });

  return state;
}

export const session = createSession();
```

Three transitions, all explicit:

```txt
* → pending      no-op
* → signed-out   dispose previous fuji if any, set status
signed-out/pending → signed-in   build fuji
signed-in → signed-in (same user)   refresh encryption keys, no rebuild
signed-in → signed-in (different user)   dispose old fuji, build new fuji
```

The same-user branch is what the old `auth.onStateChange` handler in the provider was doing imperatively, plus the `{#key}` remount. Now it is one branch in one state machine.

### Entries lives on fuji

`entries-state.svelte.ts` was three jobs in one file:

```ts
// before
function createEntriesStateForFuji() {
  const map = fromTable(fuji.tables.entries);
  const all = $derived([...map.values()]);
  const active = $derived(all.filter((e) => e.deletedAt === undefined));
  const deleted = $derived(all.filter((e) => e.deletedAt !== undefined));
  return {
    [Symbol.dispose]() { map[Symbol.dispose](); },
    get(id) { return map.get(id); },
    get active() { return active; },
    get deleted() { return deleted; },
    createEntry() {
      const { id } = fuji.actions.entries.create({});
      goto(`/entries/${id}`); // <- UI policy hidden inside data layer
    },
  };
}
```

Three concerns:

1. **Reactive views over fuji** (`active`, `deleted`): pure data, belongs on fuji.
2. **Lifecycle wrapper at the time** (`fromTable` + `[Symbol.dispose]`): this was obsolete after `fromTable` became a readonly view with its own `createSubscriber` lifecycle.
3. **`createEntry` with navigation**: UI policy. Two lines in a click handler.

Refusal: drop the bundled `createEntry()`. Move reactive views onto `fuji.entries`. Let the click handler call `fuji.actions.entries.create()` then `goto()`. The `entries-state.svelte.ts` file deletes.

```ts
// apps/fuji/src/lib/fuji/browser.ts (after)
export function openFuji({ identity, peer, bearerToken }: ...) {
  // ... existing setup ...
  const entriesMap = fromTable(doc.tables.entries);
  const entriesAll = $derived([...entriesMap.values()]);
  const entriesActive = $derived(entriesAll.filter((e) => e.deletedAt === undefined));
  const entriesDeleted = $derived(entriesAll.filter((e) => e.deletedAt !== undefined));

  return {
    ...doc,
    entries: {
      get: (id: EntryId) => entriesMap.get(id),
      get active() { return entriesActive; },
      get deleted() { return entriesDeleted; },
    },
    // ... existing fields ...
    [Symbol.dispose]() {
      entriesMap[Symbol.dispose]();
      entryContentDocs[Symbol.dispose]();
      doc[Symbol.dispose]();
    },
  };
}
```

`$derived` works in `.svelte.ts` modules; `openFuji` is called from a component scope (the session subscription runs synchronously inside the layout's render path), so the tracked scope is satisfied.

If `$derived` at module-level in `browser.ts` is undesirable for layering reasons (the file currently has no Svelte runes), the alternative is a thin `attachSvelteViews(fuji)` factory in `$lib/session.svelte.ts` that adds the views. The reactive views still belong logically on the fuji bundle; the question is just where the `$derived` keyword physically lives. Either is acceptable; pick during implementation.

### Layout narrows once

```svelte
<!-- apps/fuji/src/routes/+layout.svelte -->
<script lang="ts">
  import { session } from '$lib/session.svelte';
  // ...
</script>

{#if session.status === 'pending'}
  <Loading />
{:else if session.status === 'signed-out'}
  <AuthForm {auth} ... />
{:else}
  {#await session.fuji.whenLoaded}
    <Spinner />
  {:then}
    <SignedInSessionScope session={session}>
      <FujiAppShell>{@render children()}</FujiAppShell>
    </SignedInSessionScope>
  {/await}
{/if}
```

No `{#key}`. No `<FujiWorkspaceProvider>`. The discriminated union is narrowed once. Identity changes are handled by the state machine, not by remounting components.

### Route groups can make the boundary visible

Fuji can keep the signed-in branch in the root layout if the whole app is one protected surface plus the auth form. If the routes are already conceptually split, prefer a SvelteKit route group:

```txt
apps/fuji/src/routes/
  +layout.svelte
  sign-in/+page.svelte
  (signed-in)/+layout.svelte
  (signed-in)/+page.svelte
  (signed-in)/entries/[id]/+page.svelte
  (signed-in)/trash/+page.svelte
```

The route group is not the invariant by itself. It is the file-tree boundary that says where the invariant is installed:

```txt
outside (signed-in)   auth may be pending, signed-out, or signed-in
inside (signed-in)    SignedInSession context is present
```

In SPA mode, do not rely on `+layout.ts` alone to own this. A load function can redirect during navigation, but auth can change without navigation: sign out, account refresh, cookie expiry, another tab, or an OAuth return. The live Svelte layout still needs to branch on `auth.state` or the composed `session`.

### Context carries the signed-in type

The context getter should be named for the invariant it returns, not for the
route shape that made the invariant true. `getProtectedSession()` sounds like a
route helper: useful only because the caller happens to live under a protected
layout. `getSignedInSession()` says what TypeScript can rely on: the returned
value is the signed-in variant, so `identity` and `fuji` are present.

Do not split this into `getIdentity()` and `getFuji()` contexts. The invariant
is the pair: this Fuji workspace belongs to this signed-in identity. Two
contexts make it possible for the code shape to drift back toward two cells,
even if the runtime happens to set them in the same component today. One
context preserves one scoped capability.

Use this vocabulary:

```txt
session                 full discriminated union, exported from session.svelte.ts
SignedInSession          narrowed signed-in variant
getSignedInSession()     context getter for signed-in consumers
setSignedInSession()     context setter used only by the scope component
SignedInSessionScope     component that installs the narrowed context
```

Do not keep `getSession()` as a convenience alias. It is shorter, but it hides
the clean break. This app has two session shapes now: the full auth/workspace
state machine and the signed-in consumer context. The names should make the
difference visible.

```ts
// $lib/session.svelte.ts
import { createContext } from 'svelte';

export type SignedInSession = Extract<Session, { status: 'signed-in' }>;
export const [getSignedInSession, setSignedInSession] =
  createContext<SignedInSession>();
```

```svelte
<!-- $lib/components/SignedInSessionScope.svelte -->
<script lang="ts">
  import { setSignedInSession, type SignedInSession } from '$lib/session.svelte';
  import type { Snippet } from 'svelte';
  let { session, children }: { session: SignedInSession; children: Snippet } = $props();
  setSignedInSession(session);
</script>

{@render children()}
```

Context is allowed here because the value has the same lifetime as the scope.
Svelte context is not reactive by itself: setting context does not rerun when a
local variable is reassigned. That is fine for this boundary. The signed-in
session object is created once for the signed-in scope, installed once, and read
by descendants that are mounted under that scope.

If the implementation chooses a keyed route-boundary variant instead of the
central `session.svelte.ts` state machine, the layout key must be the user id
and the scope component must construct the signed-in session from that identity:

```svelte
{#if auth.state.status === 'pending'}
  <Loading />
{:else if auth.state.status === 'signed-out'}
  <AuthForm {auth} />
{:else}
  {#key auth.state.identity.user.id}
    <SignedInSessionScope identity={auth.state.identity}>
      <FujiAppShell>{@render children()}</FujiAppShell>
    </SignedInSessionScope>
  {/key}
{/if}
```

```svelte
<!-- $lib/components/SignedInSessionScope.svelte, keyed variant -->
<script lang="ts">
  import { getOrCreateInstallationId } from '@epicenter/workspace';
  import type { AuthIdentity } from '@epicenter/auth';
  import { onDestroy, type Snippet } from 'svelte';
  import { auth } from '$lib/auth';
  import { openFuji } from '$lib/fuji/browser';
  import { setSignedInSession } from '$lib/session.svelte';

  let {
    identity,
    children,
  }: {
    identity: AuthIdentity;
    children: Snippet;
  } = $props();

  const fuji = openFuji({
    identity,
    peer: { id: getOrCreateInstallationId(localStorage), name: 'Fuji', platform: 'web' },
    bearerToken: () => auth.bearerToken,
  });

  setSignedInSession({ status: 'signed-in', identity, fuji });
  onDestroy(() => fuji[Symbol.dispose]());
</script>

{@render children()}
```

On a different-user transition, Svelte destroys the old keyed subtree, runs the
scope cleanup, drops the old context, mounts a new scope, and descendants call
the context getter again. On a same-user refresh, the key does not change. Keep
the workspace mounted and apply refreshed encryption keys to the existing
workspace.

```svelte
<!-- consumer -->
<script lang="ts">
  import { getSignedInSession } from '$lib/session.svelte';
  const { fuji } = getSignedInSession();
</script>

{#each fuji.entries.active as entry (entry.id)}
  <NoteCard
    {entry}
    onDelete={() => fuji.actions.entries.softDelete(entry.id)}
  />
{/each}
```

Consumers get the narrowed type. No status check, no `if (session.status === 'signed-in')` ritual at every callsite. The narrowing is paid once at the layout boundary; context delivers the proven-signed-in shape everywhere else.

### Create-and-navigate at the consumer

```svelte
<!-- consumer that creates an entry -->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { getSignedInSession } from '$lib/session.svelte';
  const { fuji } = getSignedInSession();

  function newEntry() {
    const { id } = fuji.actions.entries.create({});
    goto(`/entries/${id}`);
  }
</script>

<button onclick={newEntry}>New entry</button>
```

Two lines. Replaces the indirect `entriesState.createEntry()` call. The navigation policy lives where the click handler lives.

## Cell Count

```txt
                  before                              after
session state     auth.state                          auth.state (unchanged)
workspace state   workspace.ts fujiInstance           field of session.signed-in
entries state     entries-state.svelte.ts delegate    field of fuji
sync mechanism    FujiWorkspaceProvider               $state in session.svelte.ts
```

One mutable cell, owned by Svelte's `$state`, in the file that owns the session state machine. Everywhere else: pure reads.

## What Changes

### New files

- `apps/fuji/src/lib/session.svelte.ts`: session state machine, `createContext` exports
- `apps/fuji/src/lib/components/SignedInSessionScope.svelte`: thin context-setter component

### Modified files

- `apps/fuji/src/lib/fuji/browser.ts`: `openFuji` returns an `entries` field with reactive views
- `apps/fuji/src/routes/+layout.svelte`: narrows once via `session.status`, no provider, no `{#key}`
- All consumers of `fuji` / `entriesState` / `protectedAuth.identity`: use `getSignedInSession()` instead
- `apps/fuji/src/lib/auth.ts`: `protectedAuth` deleted; identity is read via `getSignedInSession().identity`

### Deleted files

- `apps/fuji/src/lib/workspace.ts` (entire file: Proxy, lazy init, dispose, HMR hook)
- `apps/fuji/src/lib/entries-state.svelte.ts` (entire file: views move to fuji, navigation moves to consumers)
- `apps/fuji/src/lib/components/FujiWorkspaceProvider.svelte` (entire file: lifecycle role evaporates)

## Wave Ordering

```txt
Wave 1   Add session.svelte.ts beside existing workspace.ts.
         Wire openFuji.entries (the reactive views).
         Both code paths exist; nothing imports session yet.

Wave 2   Update +layout.svelte to use session-based narrowing.
         Add SignedInSessionScope component, switch consumers to getSignedInSession().
         Old workspace.ts / entries-state.svelte.ts still on disk, no longer imported.

Wave 3   Verify: typecheck, build, manual smoke (sign in, sign out, create entry, identity switch).
         Stop here if anything is off.

Wave 4   Delete workspace.ts, entries-state.svelte.ts, FujiWorkspaceProvider.svelte, protectedAuth.
         Remove HMR dispose hooks. Final typecheck.
```

Wave 3 is the rollback point. If verification finds anything wrong, the old files are still there and the import switch is reversible in one PR.

## Tradeoffs

**Workspace constructs eagerly on sign-in.** The Proxy was lazy; the new shape is not. Cost: a few hundred milliseconds at sign-in time that previously happened on first read. Benefit: no lazy-init invariant to maintain, no Proxy debugging, no "what if I read this from a non-tracked scope" footgun.

**One file owns the session state machine.** Today the state machine is implicit, scattered across `workspace.ts` (the cell), the provider (mount/destroy), and `auth.onStateChange` callbacks (transitions). Pulling it into `session.svelte.ts` makes it visible. Cost: one new file; a slightly long subscription handler. Benefit: every transition is in one switch.

**Consumers read via `getSignedInSession()` instead of `import { fuji }`.** One line of ritual per component. Cost: minor ergonomic. Benefit: `fuji` is provably non-null; no protected getter; tests can wrap subtrees with a fixture session.

**`session.fuji.entries.active` instead of `entriesState.active`.** Slightly longer property path. Benefit: one bundle to import; fuji is the obvious owner; no separate file to maintain.

## Generalization

The same three-cell drift exists in:

- `apps/honeycrisp/src/lib/workspace.ts` and `apps/honeycrisp/src/lib/state/*.svelte.ts`
- `apps/zhongwen/src/lib/zhongwen/browser.ts` and friends

This spec is Fuji-scoped because Fuji is the simplest case and the canonical example. Honeycrisp and Zhongwen should follow the same pattern in follow-up specs once the Fuji shape is validated.

## Final Check

- One sentence: "In Fuji, the workspace exists exactly when a user is signed in." No "or," no "also," no "when not yet attached."
- One owner per invariant: auth state owns "signed-in"; session state machine owns the workspace lifecycle as a derived consequence.
- One obvious consumer path: `getSignedInSession()` returns the narrowed signed-in session.
- Old vocabulary deleted, not aliased: no `protectedAuth`, no `fuji` Proxy, no `entriesState`.
- File tree matches new ownership: `session.svelte.ts` exists; `workspace.ts`, `entries-state.svelte.ts`, `FujiWorkspaceProvider.svelte` are gone.
