# Sync Token Source And Disposable Child Docs

**Date**: 2026-05-02
**Status**: Implemented
**Author**: AI-assisted
**Branch**: codex/explicit-daemon-host-config

**Supersedes**: `20260502T232158-sync-token-source-and-document-family-boundary.md`

## One-Sentence Test

`attachSync` owns credential freshness; browser apps own their per-row child document caches directly with `createDisposableCache`.

This spec takes the stronger position from the prior design discussion. Once sync reconnect behavior moves into `attachSync`, `createBrowserDocumentFamily` no longer earns a domain abstraction. It becomes a thin wrapper around `createDisposableCache` plus a source-owned cleanup callback. That wrapper should be deleted, not renamed.

## Overview

Move token-change reconnect behavior into `attachSync`, then replace `createBrowserDocumentFamily` call sites with direct `createDisposableCache` usage and app-owned cleanup functions.

The target is not a better-named family abstraction. The target is no family abstraction at all. Browser apps already know their parent tables, child document guid functions, and storage cleanup policy. The workspace package should keep the generic disposable cache and the sync transport, but it should not invent a middle layer for per-row browser child documents.

## Motivation

### Current State

The code currently has three separate concepts collapsed together:

```txt
createDisposableCache
  generic id -> disposable value cache

createBrowserDocumentFamily
  id -> browser child document cache
  clear all child local storage
  currently also sync fanout

attachSync
  one WebSocket sync attachment for one Y.Doc
```

The first and third concepts are strong. `createDisposableCache` owns refcounted reuse and disposal. `attachSync` owns WebSocket connection lifecycle. The middle concept is now suspect.

The family abstraction originally looked more useful because it carried sync fanout:

```txt
family knows active child docs
family tracks active child sync controls
auth-workspace reconnects root + children through family.syncControl
```

After the token-source redesign, this fanout belongs inside each sync attachment:

```txt
AuthClient changes token
TokenSource notifies
each attachSync reconnects itself
```

At that point, the family wrapper reduces to:

```txt
open(id)
has(id)
clearLocalData()
dispose()
```

`open`, `has`, and `dispose` already come from `createDisposableCache`. The remaining cleanup operation is app-specific policy.

### Desired State

Browser app modules should compose the primitives directly:

```ts
const noteBodyDocs = createDisposableCache(
	(noteId: NoteId) => {
		const ydoc = new Y.Doc({
			guid: noteBodyDocGuid({
				workspaceId: doc.ydoc.guid,
				noteId,
			}),
			gc: false,
		});
		const body = attachRichText(ydoc);
		const idb = attachIndexedDb(ydoc);
		const sync = attachSync(ydoc, {
			url: toWsUrl(`${APP_URLS.API}/docs/${ydoc.guid}`),
			waitFor: idb.whenLoaded,
			tokenSource,
		});

		return {
			ydoc,
			body,
			idb,
			sync,
			whenLoaded: idb.whenLoaded,
			[Symbol.dispose]() {
				ydoc.destroy();
			},
		};
	},
	{ gcTime: 5_000 },
);

async function clearNoteBodyLocalData() {
	await Promise.all(
		doc.tables.notes.getAllValid().map((note) =>
			clearDocument(
				noteBodyDocGuid({
					workspaceId: doc.ydoc.guid,
					noteId: note.id,
				}),
			),
		),
	);
}
```

The returned workspace object then exposes a domain-named child cache and clear function:

```ts
return {
	...doc,
	noteBodyDocs,
	async clearLocalData() {
		await clearNoteBodyLocalData();
		await idb.clearLocal();
	},
	[Symbol.dispose]() {
		noteBodyDocs[Symbol.dispose]();
		tokenSource[Symbol.dispose]?.();
		doc[Symbol.dispose]();
	},
};
```

No `BrowserDocumentFamily`. No `BrowserDocumentInstance`. No `sync: null`. No `getSyncControl`.

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Credential freshness | `attachSync` subscribes to `TokenSource` | The sync attachment owns the socket. It should reconnect the socket when credentials change. |
| Child document caching | Direct `createDisposableCache` in app browser modules | The app knows the row table, guid format, child document factory, and storage cleanup policy. |
| Browser document family abstraction | Delete it | After sync moves out, it duplicates `createDisposableCache` and adds one app-specific cleanup callback. |
| `getSyncControl` option | Do not add | It keeps network lifecycle attached to a cache abstraction. |
| Server-side live revocation | Out of scope | Already-open sockets remain accepted until they close. Live revocation is a separate security feature with revocation storage and DO checks. |
| Existing `getToken` support | Keep during migration | Daemon and script sync call sites may not have an `AuthClient`. |

## Architecture

Target ownership:

```txt
AuthClient
  owns current session token
  emits snapshot changes

TokenSource
  adapts AuthClient to getToken plus onTokenChange

attachSync
  owns one WebSocket for one Y.Doc
  reads token before connecting
  reconnects when TokenSource changes
  tears down when Y.Doc is destroyed

createDisposableCache
  owns id-based reuse
  owns refcounted handles
  owns delayed disposal

browser app module
  owns child document factories
  owns child storage cleanup
  names child caches in domain language
```

The important removal:

```txt
createBrowserDocumentFamily
  removed
```

## Why This Is Better Than A Rename

Renaming `createBrowserDocumentFamily` to `createBrowserChildDocumentCache` would make the name more precise, but it would preserve a weak layer. The function would still mostly forward to `createDisposableCache` while carrying cleanup that each app already has to define.

The cleaner result is to let each browser app write the composition it actually owns:

```txt
create child doc
cache child doc by id
clear stored child docs from this app's table
```

That makes the call site longer, but more honest. There is no extra abstraction to learn.

## Implementation Plan

### Phase 1: Token Source And attachSync

- [x] Add a `TokenSource` type near `attachSync`.
- [x] Add `createAuthTokenSource(auth)` in `@epicenter/auth-workspace` or the most appropriate auth integration package.
- [x] Extend `attachSync` to accept `tokenSource`.
- [x] Reject configs that pass both `getToken` and `tokenSource`.
- [x] Subscribe to `tokenSource.onTokenChange()` and call the sync attachment's own `reconnect()`.
- [x] Unsubscribe on `ydoc.destroy`.
- [x] Keep existing `getToken` support for daemon and script call sites.

### Phase 2: Browser Apps Use TokenSource

- [x] Update Honeycrisp root and note body sync to share one token source.
- [x] Update Fuji root and entry content sync to share one token source.
- [x] Update Opensidian root sync to use token source. Its file content docs are local-only.
- [x] Update Tab Manager and Zhongwen if their browser sync setup uses `AuthClient`.
- [x] Dispose token sources from the returned browser workspace object if the adapter is disposable.

### Phase 3: Delete BrowserDocumentFamily

- [x] Replace `createBrowserDocumentFamily` call sites with direct `createDisposableCache`.
- [x] Move `clearLocalData()` logic into app-local helper functions such as `clearNoteBodyLocalData()`.
- [x] Remove `sync: null` from local-only child docs.
- [x] Delete `packages/workspace/src/cache/browser-document-family.ts`.
- [x] Delete or replace `packages/workspace/src/cache/browser-document-family.test.ts`.
- [x] Remove exports from `packages/workspace/src/index.ts`.
- [x] Update workspace package examples and README text that mention browser document families.

### Phase 4: Auth Workspace Cleanup

- [x] Remove same-user token reconnect responsibility from `bindAuthWorkspaceScope` if `attachSync` now owns it.
- [x] Keep user switch and signed-out terminal reset behavior.
- [x] Update `packages/auth-workspace/src/index.test.ts` to cover session application, token-source notification, and terminal reset sequencing.

### Phase 5: Svelte Helpers

- [x] Inspect `packages/svelte-utils/src/from-document-family.svelte.ts`.
- [x] If it only adapts the old family API, either delete it or replace it with a helper that consumes a plain `DisposableCache`.
- [x] Prefer direct cache usage unless the helper earns its own one-sentence test.

## Edge Cases

### Existing Child Handle During Auth Reset

The current app reset path clears local data and reloads. Do not preserve a family abstraction only to pause child sync before reload. If a cache is disposed during reset, audit mounted UI handles carefully. If the implementation keeps the current reset sequence and relies on reload, that is acceptable.

### Token Changes Before First Connection

`attachSync` should read the latest token at connect time. If a token changes before IndexedDB `waitFor` resolves, reconnecting or restarting the pending cycle is acceptable as long as only one live socket exists.

### Remote Session Revocation

This spec does not add server-side live revocation. A socket accepted by the Worker can remain connected until it closes. That is existing behavior. Fixing that requires a separate backend auth-revocation design.

## Success Criteria

- [x] No source file imports `createBrowserDocumentFamily`.
- [x] `packages/workspace/src/cache/browser-document-family.ts` is removed.
- [x] Browser app child docs use `createDisposableCache` directly.
- [x] Local-only child docs no longer include `sync: null`.
- [x] `attachSync` reconnects itself when its `TokenSource` token changes.
- [x] `BrowserDocumentFamily`, `BrowserDocumentFamilySource`, and `BrowserDocumentInstance` are no longer exported from `@epicenter/workspace`.
- [x] Existing daemon and script `getToken` sync call sites still compile.
- [x] Tests cover `attachSync` token-source reconnect and `createDisposableCache` behavior directly.
- [x] Targeted workspace and auth-workspace typechecks pass.

## Files To Inspect

```txt
packages/workspace/src/document/attach-sync.ts
packages/workspace/src/document/attach-sync.test.ts
packages/workspace/src/cache/disposable-cache.ts
packages/workspace/src/cache/browser-document-family.ts
packages/workspace/src/cache/browser-document-family.test.ts
packages/workspace/src/index.ts
packages/auth-workspace/src/index.ts
packages/auth-workspace/src/index.test.ts
packages/svelte-utils/src/from-document-family.svelte.ts
apps/honeycrisp/src/lib/honeycrisp/browser.ts
apps/fuji/src/lib/fuji/browser.ts
apps/opensidian/src/lib/opensidian/browser.ts
apps/skills/src/lib/skills/browser.ts
apps/tab-manager/src/lib/tab-manager/extension.ts
apps/zhongwen/src/lib/zhongwen/browser.ts
packages/filesystem/src/file-content-docs.ts
packages/skills/README.md
packages/workspace/README.md
```

## Verification Commands

```sh
bun test packages/workspace/src/document/attach-sync.test.ts
bun test packages/auth-workspace/src/index.test.ts
bun test packages/workspace/src/cache/disposable-cache.test.ts
bun run --filter @epicenter/workspace typecheck
bun run --filter @epicenter/auth-workspace typecheck
```

Run app typechecks where practical. If they fail on existing unrelated Svelte or UI diagnostics, report the first unrelated errors and keep the implementation scoped.

## Review

**Completed**: 2026-05-03
**Branch**: codex/explicit-daemon-host-config

### Summary

`attachSync` now owns token-source reconnects while preserving `getToken` for daemon and script callers. Browser child documents now use direct `createDisposableCache` composition with app-local cleanup helpers, and the old browser document family module, tests, exports, and Svelte adapter have been removed.

### Deviations From Spec

- `fromDocumentFamily` was replaced with `fromDisposableCache`, now named `useCacheHandle`, because five Svelte call sites shared the same reactive open and dispose pattern. The helper earns the one-sentence test: bind a plain disposable cache to a reactive id and dispose the previous handle on id changes.
- Zhongwen has no compatible browser sync setup in its current client path, so there was no token-source browser sync call site to update.

### Verification

- `bun test packages/workspace/src/document/attach-sync.test.ts`: passed.
- `bun test packages/auth-workspace/src/index.test.ts`: passed.
- `bun test packages/workspace/src/cache/disposable-cache.test.ts`: passed.
- `bun run --filter @epicenter/workspace typecheck`: passed.
- `bun run --filter @epicenter/auth-workspace typecheck`: passed.
- `bun run --filter @epicenter/skills typecheck`: passed.
- `bun run --filter @epicenter/filesystem typecheck`: passed.
- `bun test apps/honeycrisp/src/lib/honeycrisp`: passed.
- `bun test apps/fuji/src/lib/fuji`: passed.
- `bun test apps/opensidian/src/lib/opensidian`: passed.

### App Typecheck Notes

App and Svelte package checks are still blocked by unrelated existing diagnostics. First blockers include `packages/svelte-utils/src/from-table.svelte.ts` expecting `result.status` and `result.row` on a `Result`, `packages/ui` alias imports such as `#/utils.js` failing under app checks, and existing app-local diagnostics such as Fuji `EntriesTable.svelte` `tabindex` typing.
