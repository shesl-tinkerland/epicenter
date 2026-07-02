# Progressive sign-in collapse: delete the gates, one composition shape

**Date**: 2026-07-01
**Status**: Draft
**Owner**: Braden
**Branch**: progressive-sign-in (waves branch off main as they start)
**Relates**: [ADR-0088](../docs/adr/0088-sign-in-is-an-enhancement-never-a-door.md) (the decision this spec executes), [ADR-0071](../docs/adr/0071-oauth-is-hosted-only-a-custom-instance-requires-a-token.md), [ADR-0075](../docs/adr/0075-self-host-is-a-single-partition-instance-behind-one-operator-supplied-bearer.md), [ADR-0079](../docs/adr/0079-whispering-authenticates-with-an-oauth-bearer-on-every-surface.md), `specs/20260627T221642-whispering-optional-unified-auth.md` (the vault session that keeps `createSession` alive)
**Prompts**: `specs/20260701T151347-progressive-sign-in-collapse.prompt.md` (per-wave executor kickoffs, grill prompts, check-in protocol)

## One Sentence

Every workspace app boots into a working local doc and signs in only for
sync: the four `(signed-in)` gates are deleted and Whispering's boot-branch +
reload + flag-free migration becomes the single composition shape.

## How to read this spec

```txt
Read first (executor):
  One Sentence
  Motivation (Current State / Desired State)
  Design Decisions
  Architecture (the canonical lifecycle + extraction catalog)
  The per-app conversion recipe
  Implementation Plan (your wave only)
  Invariants (machine-checkable)

Read if changing the architecture:
  Research Findings
  Call Sites
  Edge Cases
  Open Questions

Never do:
  Do not start a wave before the previous wave's PR is merged.
  Do not touch apps/api/ui (the dashboard keeps its gate by design).
  Do not add an anonymous/guest state to AuthState.
  Do not copy code from an apps/* or app-shell (AGPL) file into an MIT
  package (packages/workspace, packages/identity); that is a relicensing act.
```

## Overview

This spec extracts Whispering's already-shipped progressive sign-in machinery
into shared packages, converts opensidian, honeycrisp, vocab, and tab-manager
to it one app at a time, and then deletes the gate world (`SignedOutScreen`,
`(signed-in)` route groups, the Shape A composition). It is sequenced as
Build, Prove, Remove: nothing is deleted before every consumer has moved.

## Motivation

### Current State

Whispering is the reference implementation. Its boot branch
(`apps/whispering/src/lib/whispering/whispering.active.ts:70-88`) reads
persisted auth once, synchronously, at module load:

```ts
function openActiveWhispering(defaultTranscriptionService: TranscriptionServiceId) {
	const workspace = createWhispering({ defaultTranscriptionService });
	attachBroadcastChannel(workspace.ydoc);

	if (auth.state.status === 'signed-out') {
		const idb = attachIndexedDb(workspace.ydoc);
		return { workspace, whenReady: idb.whenLoaded, collaboration: undefined };
	}

	const signedIn = buildSignedIn(auth);
	const { idb, collaboration } = connectDoc(
		workspace.ydoc,
		{ ...signedIn, nodeId },
		{ actions: workspace.actions },
	);
	return { workspace, whenReady: idb.whenLoaded, collaboration };
}
```

Every other workspace app hard-gates. The gate is the same ~27 lines in each
(`apps/honeycrisp/src/routes/(signed-in)/+layout.svelte`, and near-identical
files in opensidian and vocab; tab-manager inlines the branch in
`apps/tab-manager/src/entrypoints/sidepanel/App.svelte:12-46`):

```svelte
{#if session.current}
	<WorkspaceGate
		pending={session.current.idb.whenLoaded}
		onForgetDevice={() => requireHoneycrisp().wipe()}
		onSignOut={() => auth.signOut()}
	>
		<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>
	</WorkspaceGate>
{:else}
	<SignedOutScreen
		appName="Honeycrisp"
		tagline="Sync your notes across devices."
		{auth}
		setting={instanceSetting}
	/>
{/if}
```

Behind that gate sits Shape A: a `createSession(auth, build)` singleton whose
payload is `null` while signed out, plus a `require<App>()` accessor that
throws when signed out (`apps/honeycrisp/src/lib/session.ts:7-24` and
siblings in vocab, opensidian, tab-manager).

This creates problems:

1. **The product contradiction**: an app you cannot open without an account
   is not local-first. Whispering proves the alternative ships.
2. **Two composition shapes**: every new app, doc, and reviewer pays the
   Shape A vs Shape B decision tax (`workspace-app-composition` skill
   documents both).
3. **Dead shared surface**: `AccountPopover`'s signed-out `SignInPanel`
   branch is unreachable in the four gated apps, which is why
   `instanceConnect` had to be an optional prop (#2250).
4. **Null-workspace ceremony**: `session.current` checks, `require*()`
   throws, and vocab's `/sign-in` redirect choreography exist only to manage
   a workspace that is allowed to not exist.

### Desired State

One shape, everywhere:

```txt
boot: read persisted auth ONCE (module load)
  signed-out          -> workspace on bare IDB (db name = ydoc.guid), collaboration: undefined
  signed-in / reauth  -> workspace on owner-scoped IDB + relay (connectDoc)
identity change       -> location.reload() (reloadOnOwnerChange, keyed on ownerId, not status)
first signed-in boot
  with local rows     -> Add / Delete / Keep migration dialog (flag-free)
auth surface          -> AccountPopover only; SignedOutScreen deleted
```

The workspace singleton is never `null`. `require*()` accessors and
`(signed-in)` route groups are deleted. Signed-in-only features render a
small inline affordance instead of gating the app.

## Research Findings

### Gate census (2026-07-01, main at `fe24a002a7`)

| App | Gate | Shape | AccountPopover | instance.ts | Gate-dedicated code |
| --- | --- | --- | --- | --- | --- |
| whispering | none | boot-branch singleton | yes, with `instanceConnect` | yes | 0 (has 346-line reload + migration machinery instead) |
| honeycrisp | `(signed-in)/+layout.svelte` | A (`createSession`) | yes | yes | 27 lines |
| opensidian | `(signed-in)/+layout.svelte` | A | yes | yes | 26 lines |
| vocab | `(signed-in)/+layout` + `$effect` redirect to `/sign-in` | A | **none** | yes | 48 lines (2 files) |
| tab-manager | inline `{#if}` in `App.svelte` | A, deferred-init (async `chrome.storage`) | yes | async (`loadInstanceSetting`) | ~13 lines inline |
| api/ui dashboard | `(signed-in)` inline | no workspace, cookie auth | no (bespoke `UserMenu`) | n/a | out of scope |

**Key finding**: the gates themselves are tiny; the deletion target is Shape A
as a concept (null workspace, `require*()`, redirect routes, two documented
shapes).

**Drift note (post `450f488854`, PR #2253)**: honeycrisp's workspace nested
under `$lib/workspace/` and auth moved behind `#platform/auth`; the gate and
Shape A session are unchanged, so the recipe holds. ADR-0087 (honeycrisp is
the maintained notes product) stands; its Shape A auth-lifecycle clause is
superseded by ADR-0088. ADR-0086 retires opensidian's chat and cross-device
surfaces (superseded by the super app), which rescopes opensidian's
conversion to minimal (see per-app judgment points).

### The break is compatibility-free

- Gated apps never wrote unowned local data (the workspace did not exist
  signed out), so there is no old on-disk format to read.
- Existing users hold persisted grants and boot signed-in; conversion day
  changes nothing for them.
- Local and owner docs can never collide: bare doc is IDB `"<ydoc.guid>"`
  (`packages/workspace/src/document/attach-indexed-db.ts:10`); owner doc is
  `"epicenter/<server>/owners/<ownerId>/<guid>"`
  (`packages/workspace/src/document/local-yjs-key.ts:40-46`). Whispering's
  migration exploits this by opening the bare doc as a second throwaway
  instance while signed in
  (`apps/whispering/src/lib/migration/sign-in-migration.svelte.ts:42-59`).

### The platform's lower layers already agree

`defineMount` treats a signed-out machine as first-class;
`defineSessionMount` is the opt-in fail-closed variant
(`packages/workspace/src/daemon/define-mount.ts:134-148`). The CLI maps "no
saved session" to a valid `null` session (`packages/cli/src/commands/up.ts:155-166`).
Only the UI layer still believes sign-in is a door.

### What keeps `createSession` alive

`specs/20260627T221642-whispering-optional-unified-auth.md` uses
`createSession` as the additive signed-in-only overlay that fetches the vault
keyring. So `createSession` is demoted (never again owns a workspace
lifecycle), not deleted. Do not remove it in Wave 4.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Refuse app-level sign-in gates | 2 coherence | Delete all four gates | ADR-0088; the local-first product sentence. |
| One composition shape | 1 evidence | Whispering's boot-branch + reload | Shipped and live in `whispering.active.ts`; census confirms every keying invariant holds. |
| Identity change handling | 1 evidence | `location.reload()`, never in-place doc swap | Whispering's Option A decision, re-verified: reload deletes hot-swap, rebinding, and reactive re-auth machinery. `reloadOnOwnerChange` keys on `ownerId`, so token expiry never reloads. |
| Boot-branch helper home | 2 coherence | `@epicenter/svelte/auth` (`packages/svelte-utils/src/`) | Sibling of `createSession`; already imports `@epicenter/auth`; MIT `packages/workspace` cannot (license firewall). |
| Migration kit home | 2 coherence | `@epicenter/app-shell` | Source is AGPL app code and app-shell is AGPL: no relicensing. Dialog + state factory belong beside the popover they cooperate with. |
| No anonymous identity | 2 coherence | `AuthState` stays 3 states; local doc is unowned, keyed by guid | Matches Whispering; a guest `ownerId` would ripple through every AuthState consumer for zero product gain. |
| Sign-out semantics | 2 coherence | Reveal the local doc; delete nothing; "Forget this device" is the only wipe | Settles the open question Whispering's spec left; same answer in every app is the point. Owner replica stays on disk, disconnected. |
| Signed-in-only features | 3 taste | Inline `{#if}` affordances at each feature; refuse a `<FeatureGate>` component | ~3 sites repo-wide (opensidian cross-device, chat without a connection); a component would be indirection for a conditional. Revisit at 6+ sites. |
| `createSession` | 2 coherence | Demote, do not delete | Live future consumer: the vault keyring session (spec 20260627T221642). Update its JSDoc to say it must never own a workspace lifecycle. |
| `AccountPopover.instanceConnect` | 2 coherence | Becomes required in Wave 4 | Every popover now renders the signed-out panel; optionality existed only because gated apps could not reach it. |
| `WorkspaceGate` | 3 taste | Keep as the hydration/corrupt-store gate, mounted unconditionally | It gates on `pending` (IDB load), not auth. Constraint: do not grow auth branches into it. Revisit if apps converge on Whispering's `await whenReady` load-function pattern instead. |
| tab-manager outer `{#await}` | 3 taste | Keep | That await is async `chrome.storage`, not auth; forcing sync-storage apps to pretend otherwise is fake symmetry. |
| KV/settings migration | Deferred | Tables only, like Whispering | Whispering deliberately migrates tables, not KV (device-ish settings). Revisit per app when a user reports losing a setting they expected to carry. |
| apps/api/ui dashboard | 2 coherence | Out of scope, keeps its gate | No workspace; cookie auth; sign-in is its product. |

## Architecture

### The extraction catalog (Wave 1 output)

```ts
// @epicenter/svelte/auth  (packages/svelte-utils/src/, exported from ./auth)
connectLocalFirst({ auth, ydoc, nodeId, actions? })
//   Reads auth.state ONCE, synchronously. signed-out -> attachIndexedDb(ydoc)
//   and { whenReady, collaboration: undefined }. signed-in/reauth ->
//   connectDoc(ydoc, { server, baseURL, ownerId, openWebSocket,
//   onReconnectSignal, nodeId }, { actions }) and { whenReady, collaboration }.
//   Seed: openActiveWhispering + buildSignedIn (whispering.active.ts:54-88).
//   No $state, no reactivity: this is a plain function.

reloadOnOwnerChange(auth, { callbackPath = '/auth/callback' } = {})
//   Moved verbatim from apps/whispering/src/lib/whispering/reload-on-owner-change.ts,
//   with the callback path made a parameter. Returns the unsubscribe.

// @epicenter/app-shell  (new module, e.g. src/sign-in-migration/)
createSignInMigration({ auth, openLocalSource, target })
//   Flag-free state factory extracted from
//   apps/whispering/src/lib/migration/sign-in-migration.svelte.ts.
//   openLocalSource(): opens the app's BARE doc as a throwaway second
//   instance, returns { tables, whenReady, clearLocal, dispose }.
//   target: the live workspace ({ ydoc, tables, whenReady }).
//   check() no-ops when signed out or when every source table is empty.
//   copyTable stays an id-keyed idempotent upsert; clearLocal runs only
//   after the whole copy resolves. Table enumeration iterates the tables
//   records (shared table names), replacing Whispering's hardcoded 3-table list.

<SignInMigrationDialog {migration} ...nouns />
//   Generic Add / Delete / Keep dialog; per-app copy comes in as props.
//   Blocks dismissal while a copy/delete is in flight (Whispering's open-setter guard).
```

### What was considered and rejected

| Candidate | Why rejected |
| --- | --- |
| `<FeatureGate>` component | Three inline conditionals do not earn an abstraction. |
| Anonymous/guest `ownerId` | Fourth identity state rippling through every consumer; the unowned local doc already models it. |
| Live doc swap on sign-in | Re-adds the machine reload deleted (hot-swap, rebinding, "which doc is current"). |
| Generic KV migration | Whispering's precedent is tables-only; KV is device-flavored. Deferred per app. |
| Deleting `createSession` | The vault keyring session (spec 20260627T221642) is a real future consumer. Demoted instead. |
| Pre-save connection test in sign-in | Already refused in #2250; boot verification via `auth.connection` is the one verifier. |
| Converting apps/api/ui | No workspace to be local-first about. |

## Call sites: before and after

### honeycrisp root layout

**Before** (`apps/honeycrisp/src/routes/(signed-in)/+layout.svelte`, quoted in
Current State above): `{#if session.current}` gate, `SignedOutScreen` fallback.

**After** (moves to `apps/honeycrisp/src/routes/+layout.svelte`, route group
deleted):

```svelte
<script lang="ts">
	import { WorkspaceGate } from '@epicenter/app-shell/workspace-gate';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { honeycrisp } from '$lib/honeycrisp';
	import { auth } from '#platform/auth';
	import { onMount } from 'svelte';
	import { reloadOnOwnerChange } from '@epicenter/svelte/auth';

	let { children } = $props();
	onMount(() => reloadOnOwnerChange(auth));
</script>

<WorkspaceGate pending={honeycrisp.whenReady} onSignOut={() => auth.signOut()}>
	<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>
</WorkspaceGate>
```

**Semantic shifts to flag**: `onForgetDevice` moves to the popover and only
renders signed-in (the bare local doc has no wipe UI, matching Whispering);
the gate no longer branches on auth at all.

### honeycrisp workspace singleton

**Before** (`apps/honeycrisp/src/lib/session.ts:7-24`): `createSession` +
`requireHoneycrisp = session.require`.

**After** (`apps/honeycrisp/src/lib/honeycrisp.ts`, new module singleton):

```ts
import { connectLocalFirst } from '@epicenter/svelte/auth';
import { createNodeId } from '@epicenter/workspace';
import { auth } from '#platform/auth';
import { createHoneycrisp } from '$lib/workspace';  // the iso factory (package root export, ADR-0087)

const workspace = createHoneycrisp();
const { whenReady, collaboration } = connectLocalFirst({
	auth,
	ydoc: workspace.ydoc,
	nodeId: createNodeId({ storage: localStorage }),
	actions: workspace.actions,
});
export const honeycrisp = { ...workspace, whenReady, collaboration };
```

**Semantic shifts to flag**: every `requireHoneycrisp()` and
`session.current` call site becomes a plain `honeycrisp` import (12 files in
honeycrisp; grep list in the recipe below). `honeycrisp.collaboration` is now
`Collaboration | undefined`, and `AccountPopover` already accepts that.

### vocab

**Before**: `(signed-in)/+layout.svelte` with `$effect` redirect,
`/sign-in/+page.svelte` rendering `SignedOutScreen`, and **no AccountPopover
anywhere**.

**After**: both routes deleted; vocab mounts `AccountPopover` (with
`instanceConnect={{ appName: 'Vocab', setting: instanceSetting }}` and an
appropriate `syncNoun`) in its main chrome; conversion otherwise identical to
honeycrisp.

## The per-app conversion recipe (Waves 2 and 3)

For each app, in this order, as standalone commits:

1. **Singleton**: replace `src/lib/session.ts` with the module singleton via
   `connectLocalFirst` (see the honeycrisp after-shape). Follow the app's
   existing `open<App>Browser` / iso-factory layout per the
   `workspace-app-composition` skill; the factory itself does not change.
2. **Call-site sweep**: `rg -n "session\.(require|current)|require<App>" src/`
   and convert every hit to the singleton import. Where a component only ran
   because the gate guaranteed sign-in, the data path works unchanged against
   the local doc; only genuinely server-dependent features need step 5.
3. **Gate deletion**: flatten `(signed-in)/` into `routes/`; delete the gate
   layout; mount `WorkspaceGate pending={<app>.whenReady}` and
   `reloadOnOwnerChange` in the root layout. Vocab also deletes `/sign-in`.
4. **Account surface**: ensure `AccountPopover` renders with
   `instanceConnect={{ appName, setting: instanceSetting }}` (vocab adds the
   popover; the others add the prop). Move `onForgetDevice` here if it lived
   on the gate.
5. **Feature affordances**: for each feature that requires a server (relay,
   cross-device, hosted inference without a configured connection), render an
   inline signed-out affordance ("Sign in to use X" with copy per the
   `writing-voice` skill) instead of assuming identity. Enumerate these from
   the step-2 sweep; list them in the PR body.
6. **Migration**: wire `createSignInMigration` + `SignInMigrationDialog` with
   the app's `openLocalSource` (bare-doc second instance) and nouns; fire
   `check()` once from the root layout when signed in.
7. **Verify**: repo typecheck, the app's tests, then a manual smoke: boot
   signed out, create data, sign in, see the dialog, choose Add, confirm data
   in the owner doc and the bare doc cleared, sign out, confirm the (now
   empty) local doc and that nothing was deleted from the owner replica.

Per-app judgment points (executor decides, PR body records):

- **opensidian** (biggest sweep, ~20 files, but MINIMAL conversion): ADR-0086
  retired its chat and cross-device surfaces (the super app supersedes them),
  so prefer deleting those surfaces over gating them, do not invest in
  affordance polish, and keep the conversion to recipe steps 1-4 and 6-7. The
  point of converting opensidian at all is unblocking Wave 4's
  `SignedOutScreen` deletion while the app still has to typecheck.
- **tab-manager**: keep the outer `{#await}` (async storage); the singleton
  is built after storage resolves, then everything else follows the recipe.
  `window.location.reload()` works in the sidepanel.
- **vocab**: smallest sweep (3 files) but adds the popover.

## Implementation Plan

One wave = one PR = one merged unit before the next starts.

### Wave 0: decision records (this PR)

- [x] **0.1** ADR-0088 recorded as Proposed.
- [x] **0.2** This spec + the companion prompt file.

### Wave 1: extract the kit from Whispering (refactor-only, zero behavior change)

- [x] **1.1** Add `connectLocalFirst` to `@epicenter/svelte/auth`, seeded from
      `openActiveWhispering`/`buildSignedIn`. Unit-test the branch selection
      with a stub auth client (both statuses).
- [x] **1.2** Move `reloadOnOwnerChange` to `@epicenter/svelte/auth` with
      `callbackPath` parameterized; delete the Whispering copy; keep its tests.
- [x] **1.3** Add `createSignInMigration` + `SignInMigrationDialog` to
      app-shell, extracted from Whispering's migration files; the tables list
      becomes shared-name iteration over the two tables records.
- [x] **1.4** Point Whispering at all three; delete the app-local copies.
      Whispering's dialog copy and `openLocalSource` stay app-side.
- [x] **1.5** Demote `createSession`: JSDoc states it must never own a
      workspace lifecycle (auxiliary signed-in resources only).
- [ ] **1.6** Prove: typecheck, Whispering tests, manual smoke of Whispering's
      signed-out boot, sign-in migration, sign-out. Behavior byte-identical.

### Wave 2: convert honeycrisp (proves the recipe)

- [x] **2.1** Run the per-app recipe on honeycrisp.
- [x] **2.2** PR body lists every judgment call (feature affordances, copy).

### Wave 3: fan out (parallel, one PR each)

- [ ] **3.1** opensidian
- [ ] **3.2** vocab
- [ ] **3.3** tab-manager

### Wave 4: delete the old world

- [ ] **4.1** Delete `SignedOutScreen` and its export; `SignInPanel`'s homes
      are the popover and the instance modal.
- [ ] **4.2** Make `AccountPopover.instanceConnect` required; update JSDoc.
- [ ] **4.3** Rewrite the `workspace-app-composition` skill (both
      `.agents/skills/` and the `.claude/skills/` mirror) to one shape;
      delete Shape A / Shape B language.
- [ ] **4.4** Flip ADR-0088 to Accepted; delete this spec and the prompt
      file; add the spec-history entry.
- [ ] **4.5** Run `bun scripts/check-doc-hygiene.ts`.

## Invariants (machine-checkable, run at every check-in)

```bash
# After an app's conversion (Waves 2-3), all of these are empty for that app:
rg -l "SignedOutScreen" apps/<app>/src
rg -l "session\.(require|current)|require(Honeycrisp|Vocab|Opensidian|TabManager)" apps/<app>/src
ls apps/<app>/src/routes | rg "\(signed-in\)"

# After Wave 4, empty repo-wide:
rg -l "SignedOutScreen" apps packages
rg "Shape A|Shape B" .agents/skills/workspace-app-composition/SKILL.md

# Always true, every wave:
rg -l "createSession" packages/svelte-utils   # still exists (demoted, not deleted)
rg -l "SignedOutScreen|connectLocalFirst" apps/api/ui   # empty: dashboard untouched
```

## Edge Cases

### Sign-out after migrating

1. User migrated local rows (bare doc cleared), works signed in, signs out.
2. Next boot opens the bare doc, which is empty.
3. Expected: empty local app; owner data is invisible until re-sign-in;
   nothing was deleted. This is doctrine (ADR-0088), not a bug.

### "Keep for now", forever

1. User declines migration; local rows persist.
2. Every signed-in boot re-offers the dialog (flag-free by design).
3. Expected: acceptable; the data itself is the state. Do not add a
   "don't ask again" flag without reopening ADR-0088's flag-free stance.

### reauth-required

1. Token expires mid-session; auth publishes `reauth-required` with the same
   `ownerId`.
2. `reloadOnOwnerChange` does not fire (same owner key); collaboration
   reconnects after the popover's Reconnect.
3. Expected: no reload, no data movement.

### Two owners, one browser profile

1. Owner A signs out; owner B signs in (reload between, via the signed-out gap).
2. B's doc is `epicenter/<server>/owners/<B>/<guid>`; A's replica stays on disk.
3. The bare doc is shared by all signed-out use on the profile; whoever signs
   in next is offered its contents. Acceptable for a personal-device product;
   note it in the migration dialog copy ("data on this device").

### Extension sidepanel reload

1. tab-manager identity change fires `window.location.reload()` in the
   sidepanel document.
2. Expected: sidepanel reloads in place. Verify once during Wave 3.3; if the
   WXT environment misbehaves, fall back to a full sidepanel re-render and
   record the deviation in the PR.

## Open Questions

1. **Where does `check()` fire from in apps without Whispering's runtime-owner
   registry?**
   - Options: (a) root layout `onMount`, (b) a tiny shared `attachOnBoot`
     helper.
   - **Recommendation**: (a); do not build (b) for four one-liners. Leave open.

2. **`WorkspaceGate` vs Whispering's `await whenReady` in route loads.**
   - Both gate first paint on IDB hydration; converted apps keep
     `WorkspaceGate`, Whispering keeps its load-await.
   - **Recommendation**: tolerate both through Wave 4; converge later only if
     it bites. Leave open.

3. **Vocab's popover placement and `syncNoun`.**
   - Vocab has no chrome today that obviously hosts it.
   - **Recommendation**: executor picks the least invasive placement and
     flags it for design review in the PR. Leave open.

## Success Criteria

- [ ] All four apps boot to a working UI with no persisted auth (fresh
      profile), data creatable and persisted locally.
- [ ] Sign-in from the popover works in all four; first sign-in with local
      rows shows Add / Delete / Keep; Add moves rows and clears the bare doc.
- [ ] Sign-out reloads to the local doc; owner replica remains on disk.
- [ ] All Invariants greps pass; repo typecheck and test suites pass.
- [ ] Whispering behavior is unchanged after Wave 1 (its own smoke passes).
- [ ] ADR-0088 flipped to Accepted; this spec deleted; doc hygiene passes.

## References

- `apps/whispering/src/lib/whispering/whispering.active.ts` - the boot branch to extract.
- `apps/whispering/src/lib/whispering/reload-on-owner-change.ts` - moves to `@epicenter/svelte/auth`.
- `apps/whispering/src/lib/migration/sign-in-migration.svelte.ts` + `SignInMigrationDialog.svelte` - the migration kit to extract.
- `packages/svelte-utils/src/session.svelte.ts` - `createSession` (demote), `SignedIn` shape.
- `packages/workspace/src/document/{connect-doc,attach-indexed-db,attach-local-storage,local-yjs-key,node-id}.ts` - the storage/keying primitives (do not modify).
- `packages/app-shell/src/{account-popover,instance-settings,workspace-gate}/` - the shared surfaces this reshapes.
- `apps/{honeycrisp,opensidian,vocab}/src/routes/(signed-in)/+layout.svelte`, `apps/tab-manager/src/entrypoints/sidepanel/App.svelte` - the gates to delete.
- `apps/*/src/lib/session.ts` (`session.svelte.ts` in tab-manager) - the Shape A singletons to replace.
- `.agents/skills/workspace-app-composition/SKILL.md` - rewritten in Wave 4.
