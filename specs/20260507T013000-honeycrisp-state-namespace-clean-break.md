# Honeycrisp signed-in state namespace clean break

**Date**: 2026-05-07
**Status**: Implemented
**Branch**: chore/workspace-app-layout-skill-audit

## One-sentence thesis

```txt
The signed-in session keeps two layers: identity/resources at the top
(`userId`, `honeycrisp`) and Svelte view models grouped under `state`,
where the children are domain-named (`notes`, `folders`, `view`) and their
members carry no redundant `Note`/`Folder`/`State` suffixes.
```

If the sentence needs an "or" or a compatibility clause to stay true, the
break is incomplete.

## Overview

Rename the Honeycrisp signed-in session's reactive layer so call sites read
`signedIn.state.notes.create(folderId)` instead of
`getSignedInSession().state.notesState.createNote(folderId)`. The outer
`state` namespace stays; the `State` suffix on its children is removed; the
collection getters and methods drop their domain-name stutter.

This is a one-pass rename inside `apps/honeycrisp`. No new abstractions, no
shared types extracted, no behavior changes.

## Motivation

### Current State

```ts
// apps/honeycrisp/src/lib/session.svelte.ts
return {
  userId,
  honeycrisp,
  state, // { foldersState, notesState, viewState, [Symbol.dispose] }
  [Symbol.dispose]() { ... },
};
```

```ts
// apps/honeycrisp/src/routes/(signed-in)/state/index.ts
return {
  foldersState,
  notesState,
  viewState,
  [Symbol.dispose]() { ... },
};
```

```ts
// representative call site
const { foldersState, notesState, viewState } = getSignedInSession().state;

notesState.createNote(viewState.selectedFolderId);
notesState.notes;          // active notes
notesState.deletedNotes;   // soft-deleted notes
notesState.noteCounts;     // counts by folder
foldersState.folders;      // all folders
foldersState.createFolder();
```

### Problems

1. **Stutter at every read.** `state.notesState`, `notesState.notes`,
   `notesState.createNote`, `foldersState.folders`,
   `foldersState.createFolder`. The namespace already says "notes" or
   "folders"; repeating it on every member is ceremony.
2. **Suffix is always the same.** Inside a namespace whose entire purpose
   is reactive view models, naming each child `xxxState` tells a reader
   nothing. It is a receipt for not having a namespace at all.
3. **Destructure-and-dot-access is the local shortcut.** Every component
   destructures `state` into three local names because the member names
   are too long to use directly. That breaks the codebase rule against
   destructuring reactive accessors and hides which session you read from.

### Desired State

```ts
// apps/honeycrisp/src/lib/session.svelte.ts (unchanged shape)
return {
  userId,
  honeycrisp,
  state, // { folders, notes, view, [Symbol.dispose] }
  [Symbol.dispose]() { ... },
};
```

```ts
// representative call site
const signedIn = getSignedInSession();

signedIn.state.notes.create(signedIn.state.view.selectedFolderId);
signedIn.state.notes.all;          // active notes
signedIn.state.notes.deleted;      // soft-deleted notes
signedIn.state.notes.countsByFolder;
signedIn.state.folders.all;
signedIn.state.folders.create();
signedIn.state.view.selectFolder(folderId);
```

Two layers, one obvious shape, no suffixes, no stutter.

## Design decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Keep `state` as a grouping namespace under `signedIn`. | 2 coherence | Keep grouped (`signedIn.state.notes`), not flat (`signedIn.notes`). | Identity/resources (`userId`, `honeycrisp`) are not view models. The split is real and will grow. Reflection in [thesis-discussion]. |
| Rename `notesState` -> `notes`, `foldersState` -> `folders`, `viewState` -> `view` on the `state` group. | 2 coherence | Drop the `State` suffix from all three. | Inside `state.*`, the suffix is ceremony. |
| Drop the domain-name stutter on members of `notes` and `folders`. | 2 coherence | `notes.notes` -> `notes.all`, `notes.createNote` -> `notes.create`, `folders.folders` -> `folders.all`, `folders.createFolder` -> `folders.create`, etc. See full rename table. | The whole point of moving into a namespace is so members can be qualified by it. |
| Drop `notesState.allNotes` from the public surface. | 1 evidence | Remove the getter. | Verified: no external caller uses it. Only the internal `notes` and `deletedNotes` derivations consume the underlying `allNotes` value, which becomes a private `const` inside the factory. |
| Rename `pinNote` -> `togglePin`. | 2 coherence | Honest name. | The implementation toggles `pinned`; calling it `pin` is a lie. |
| Rename factories to match: `createNotesState` -> `createNotes`, `createFoldersState` -> `createFolders`, `createViewState` -> `createView`. | 2 coherence | Rename. | The factory builds a `notes` namespace, not a `notesState` blob. |
| Keep `createHoneycrispState` as the outer factory name. | 3 taste keep | Keep. | It builds the `state` group; the name still describes the lifecycle moment. Revisit when: another app copies this pattern and a shared name emerges. |
| Bind once at script init (`const signedIn = getSignedInSession()`). | 2 coherence | Mandatory at every call site. | Already the documented rule. The rename removes the temptation to destructure into shorter local names. |
| Do not add aliases for the old names. | 2 coherence | No aliases, no fallback parsers. | Single app, single sweep, no external consumers. Hybrid surface would defeat the point. |

## Full rename table

### `state.*` (was top-level of `createHoneycrispState`)

| Was | Becomes |
| --- | --- |
| `state.foldersState` | `state.folders` |
| `state.notesState` | `state.notes` |
| `state.viewState` | `state.view` |

### `state.notes.*` (was `notesState.*`)

| Was | Becomes | Notes |
| --- | --- | --- |
| `notesState.allNotes` | (removed from public surface) | Becomes a private `$derived` inside `createNotes`. |
| `notesState.notes` | `state.notes.all` | Active (not soft-deleted). |
| `notesState.deletedNotes` | `state.notes.deleted` | |
| `notesState.noteCounts` | `state.notes.countsByFolder` | More descriptive than `counts`. |
| `notesState.get(id)` | `state.notes.get(id)` | Unchanged. |
| `notesState.createNote(folderId)` | `state.notes.create(folderId)` | |
| `notesState.softDeleteNote(id)` | `state.notes.softDelete(id)` | |
| `notesState.restoreNote(id)` | `state.notes.restore(id)` | |
| `notesState.permanentlyDeleteNote(id)` | `state.notes.permanentlyDelete(id)` | |
| `notesState.pinNote(id)` | `state.notes.togglePin(id)` | Honest: implementation toggles. |
| `notesState.moveNoteToFolder(id, folderId)` | `state.notes.moveToFolder(id, folderId)` | |
| `notesState.updateNoteContent({...})` | `state.notes.updateContent({...})` | |

### `state.folders.*` (was `foldersState.*`)

| Was | Becomes |
| --- | --- |
| `foldersState.folders` | `state.folders.all` |
| `foldersState.get(id)` | `state.folders.get(id)` |
| `foldersState.createFolder()` | `state.folders.create()` |
| `foldersState.renameFolder(id, name)` | `state.folders.rename(id, name)` |
| `foldersState.deleteFolder(id)` | `state.folders.delete(id)` |

### `state.view.*` (was `viewState.*`)

All members keep their existing names. No stutter to remove. Only the
namespace path changes from `viewState.X` to `state.view.X`.

```txt
state.view.selectedFolderId
state.view.selectedNoteId
state.view.selectedNote
state.view.searchQuery
state.view.sortBy
state.view.isRecentlyDeletedView
state.view.folderName
state.view.filteredNotes
state.view.selectFolder(id | null)
state.view.selectRecentlyDeleted()
state.view.selectNote(id)
state.view.setSortBy(value)
state.view.setSearchQuery(query)
```

### Factory function renames

| Was | Becomes | File |
| --- | --- | --- |
| `createNotesState` | `createNotes` | `routes/(signed-in)/state/notes.svelte.ts` |
| `createFoldersState` | `createFolders` | `routes/(signed-in)/state/folders.svelte.ts` |
| `createViewState` | `createView` | `routes/(signed-in)/state/view.svelte.ts` |
| `createHoneycrispState` | (unchanged) | `routes/(signed-in)/state/index.ts` |

## Architecture

### Before

```txt
signedIn  (HoneycrispSignedIn)
├── userId
├── honeycrisp
├── state
│   ├── foldersState
│   │   ├── folders            <- stutter: foldersState.folders
│   │   ├── createFolder       <- stutter: foldersState.createFolder
│   │   ├── renameFolder
│   │   ├── deleteFolder
│   │   └── get
│   ├── notesState
│   │   ├── allNotes
│   │   ├── notes              <- stutter: notesState.notes
│   │   ├── deletedNotes
│   │   ├── noteCounts
│   │   ├── createNote         <- stutter: notesState.createNote
│   │   ├── softDeleteNote
│   │   ├── restoreNote
│   │   ├── permanentlyDeleteNote
│   │   ├── pinNote            <- dishonest: actually toggles
│   │   ├── moveNoteToFolder
│   │   ├── updateNoteContent
│   │   └── get
│   └── viewState
│       └── ...
└── [Symbol.dispose]
```

### After

```txt
signedIn  (HoneycrispSignedIn)
├── userId
├── honeycrisp
├── state
│   ├── folders
│   │   ├── all
│   │   ├── get(id)
│   │   ├── create()
│   │   ├── rename(id, name)
│   │   └── delete(id)
│   ├── notes
│   │   ├── all
│   │   ├── deleted
│   │   ├── countsByFolder
│   │   ├── get(id)
│   │   ├── create(folderId?)
│   │   ├── softDelete(id)
│   │   ├── restore(id)
│   │   ├── permanentlyDelete(id)
│   │   ├── togglePin(id)
│   │   ├── moveToFolder(id, folderId)
│   │   └── updateContent({ title, preview, wordCount })
│   └── view
│       └── ... (names unchanged, only path is now state.view.X)
└── [Symbol.dispose]
```

### File tree (unchanged)

```txt
apps/honeycrisp/src/routes/(signed-in)/state/
├── folders.svelte.ts        (createFolders)
├── index.ts                 (createHoneycrispState)
├── notes.svelte.ts          (createNotes)
├── search-params.svelte.ts  (unchanged)
└── view.svelte.ts           (createView)
```

No file moves. No new files. The directory name `state/` keeps mapping to
the `state` namespace.

## Call site rule

Every consumer must follow this shape:

```ts
const signedIn = getSignedInSession();

// Reads:
{#each signedIn.state.notes.all as note (note.id)}
{signedIn.state.notes.deleted.length}
{signedIn.state.folders.all}

// Writes:
onclick={() => signedIn.state.notes.create(signedIn.state.view.selectedFolderId)}
onclick={() => signedIn.state.folders.create()}
```

Forbidden patterns:

```ts
// Do NOT destructure into local names:
const { notes, folders, view } = getSignedInSession().state;        // forbidden
const { folders, notes, view } = signedIn.state;                    // forbidden

// Do NOT inline getSignedInSession() into templates or handlers:
{#each getSignedInSession().state.notes.all as note}                // forbidden
onclick={() => getSignedInSession().state.notes.create()}           // forbidden
```

The reasoning lives in
`apps/honeycrisp/src/lib/session.svelte.ts` JSDoc and in
`feedback_no_destructure_reactive.md` memory. Update the JSDoc example to
match the new names.

## Implementation plan

### Wave 1: Rename factories and their public surfaces

- [ ] **1.1** `apps/honeycrisp/src/routes/(signed-in)/state/folders.svelte.ts`
  - Rename `createFoldersState` -> `createFolders`.
  - Rename returned members per the table: `folders` -> `all`,
    `createFolder` -> `create`, `renameFolder` -> `rename`,
    `deleteFolder` -> `delete`.
  - Update JSDoc examples to use `signedIn.state.folders.X`.
- [ ] **1.2** `apps/honeycrisp/src/routes/(signed-in)/state/notes.svelte.ts`
  - Rename `createNotesState` -> `createNotes`.
  - Drop `allNotes` from the returned object; keep the internal
    `$derived` if it is still needed by `notes` and `deletedNotes`
    (it is, it powers both filters).
  - Rename returned members per the table.
  - Update JSDoc examples and the `restoreNote` -> `restore` internal
    reference to `foldersState.folders` (it now reads
    `foldersState.all`, but in this file the parameter is still typed
    via `ReturnType<typeof createFolders>`, so update the property
    access to `.all`).
  - Rename `pinNote` -> `togglePin`.
- [ ] **1.3** `apps/honeycrisp/src/routes/(signed-in)/state/view.svelte.ts`
  - Rename `createViewState` -> `createView`.
  - Update the parameter type from `{ foldersState, notesState }` to
    `{ folders, notes }`, typed as
    `ReturnType<typeof createFolders>` and
    `ReturnType<typeof createNotes>`.
  - Update internal reads: `notesState.notes` -> `notes.all`,
    `foldersState.get` -> `folders.get`, `notesState.get` -> `notes.get`.
  - JSDoc examples now read `signedIn.state.view.X`.
- [ ] **1.4** `apps/honeycrisp/src/routes/(signed-in)/state/index.ts`
  - Update imports to the renamed factories.
  - Build `folders`, `notes`, `view` (no `State` suffix) and return
    `{ folders, notes, view, [Symbol.dispose] }`.
  - Dispose order unchanged: notes, folders. View has no dispose.

### Wave 2: Update call sites

Use the rename table. Each call site MUST follow the bind-once rule.
Components to update (verified by grep):

- [ ] **2.1** `apps/honeycrisp/src/routes/(signed-in)/+page.svelte`
- [ ] **2.2** `apps/honeycrisp/src/routes/(signed-in)/components/CommandPalette.svelte`
- [ ] **2.3** `apps/honeycrisp/src/routes/(signed-in)/components/FolderMenuItem.svelte`
- [ ] **2.4** `apps/honeycrisp/src/routes/(signed-in)/components/NoteBodyPane.svelte`
- [ ] **2.5** `apps/honeycrisp/src/routes/(signed-in)/components/NoteCard.svelte`
- [ ] **2.6** `apps/honeycrisp/src/routes/(signed-in)/components/NoteList.svelte`
- [ ] **2.7** `apps/honeycrisp/src/routes/(signed-in)/components/Sidebar.svelte`

For each: replace any `const { ... } = getSignedInSession().state` (or
component-prop equivalents) with `const signedIn = getSignedInSession()`,
then dot-access through `signedIn.state.notes`, `signedIn.state.folders`,
`signedIn.state.view`.

### Wave 3: Update docs and JSDoc

- [ ] **3.1** `apps/honeycrisp/src/lib/session.svelte.ts` JSDoc:
  the example block already shows `signedIn.state.X`; verify it does not
  reference any old member names.
- [ ] **3.2** `apps/honeycrisp/src/routes/(signed-in)/honeycrisp/workspace.ts`
  line 139 mentions `foldersState`; update to `folders`.
- [ ] **3.3** Inside the renamed state files, ensure example blocks use
  `signedIn.state.notes.X`, `signedIn.state.folders.X`,
  `signedIn.state.view.X` consistently.

### Wave 4: Verify

- [ ] **4.1** `bun run typecheck` (or the equivalent app-scoped command;
  confirm with `bun run --filter @epicenter/honeycrisp` or whatever the
  Honeycrisp app exposes).
- [ ] **4.2** `bun run check` if the Svelte app has a `svelte-check` step.
- [ ] **4.3** Final grep sweep for old vocabulary inside
  `apps/honeycrisp/src/`:
  - `notesState`
  - `foldersState`
  - `viewState`
  - `createNotesState`
  - `createFoldersState`
  - `createViewState`
  - `createNote\b` (allow within prose docs only if outside src/)
  - `createFolder\b`
  - `deleteFolder\b`
  - `renameFolder\b`
  - `pinNote\b`
  - `softDeleteNote\b`
  - `restoreNote\b`
  - `permanentlyDeleteNote\b`
  - `moveNoteToFolder\b`
  - `updateNoteContent\b`
  - `noteCounts\b`
  - `deletedNotes\b`
  - `\.allNotes\b`
  Each remaining hit must be inside `specs/`, prior commit messages, or
  truly unrelated code. Report any other hit before declaring done.

### Wave 5: Smoke (manual)

- [ ] **5.1** Start the Honeycrisp dev server, sign in, and confirm:
  create folder, rename folder, delete folder, create note, edit note
  body, move note between folders, soft-delete note, restore from
  Recently Deleted, permanently delete, toggle pin, search filter,
  sort change, command palette folder/note jump, deleted-notes view
  toggle. The plan touches every code path in the call-site grep, so
  this is the verification that the renames did not silently break a
  binding.

## Edge cases

### Internal cross-state reads

`view.svelte.ts` consumes the notes and folders namespaces. After
rename, the parameter object is `{ folders, notes }` and its internal
reads are `notes.all`, `folders.get`, `notes.get`. The implementer must
update both the destructure on line 32 and every dot-access in the file.

`notes.svelte.ts` consumes folders inside `restore` to check whether a
note's original folder still exists. The current code reads
`foldersState.folders.some(...)`. After rename, the parameter is
`folders` and the read becomes `folders.all.some(...)`.

### Shared search params

`search-params.svelte.ts` is not renamed and is not exposed through the
state namespace. It is consumed by the factories internally. Leave it.

### Dispose order

`createHoneycrispState`'s dispose currently calls
`notesState[Symbol.dispose]()` then `foldersState[Symbol.dispose]()`.
Keep the order; only the local variable names change.

### `HoneycrispSignedIn` type

The exported `HoneycrispSignedIn` type is `InferSignedIn<typeof session>`,
so it is derived from the `build` return shape. No manual type update is
needed; TypeScript will reflect the new member names automatically.

## Open questions

1. **`countsByFolder` vs `counts`.**
   - Options: (a) `state.notes.countsByFolder`, (b) `state.notes.counts`.
   - **Recommendation**: `countsByFolder`. `counts` alone is
     ambiguous in a future where total/active/deleted counts might be
     exposed. Leave open if the implementer finds `counts` reads better
     in context.

2. **`updateContent` parameter shape.**
   - The current implementation takes `{ title, preview, wordCount }`
     and applies them to whichever note the URL search param says is
     selected. This implicit selection is a separate smell.
   - Options: (a) keep implicit selection, (b) require the caller to
     pass `noteId` explicitly.
   - **Recommendation**: Keep implicit for this spec. Refactoring the
     update flow to take `noteId` is a separate change and would balloon
     this rename. Note as a follow-up if it bothers the implementer.

3. **Should `view`'s methods drop `select` prefixes?**
   - For example `state.view.folder = id` via a setter, or
     `state.view.toFolder(id)`.
   - **Recommendation**: No. `selectFolder`/`selectNote` are honest
     verbs that name the lifecycle moment ("select"). Renaming them is
     scope creep.

## Decisions log

- Keep `state` as a namespace (do not flatten to `signedIn.notes`).
  Constraint: identity/resources and reactive view models are different
  layers, and the resource layer is expected to grow (sync clients,
  presence, additional workspace handles).
  Revisit when: the resource layer is provably stable at three members
  for two consecutive significant releases, or another app copies the
  pattern and the grouping looks redundant in that app.
- Keep the file name `state/` and `createHoneycrispState`.
  Constraint: filename matches the namespace it builds.
  Revisit when: a second app needs the same shape and the name should
  generalize.

## Success criteria

- [ ] No occurrence of `notesState`, `foldersState`, `viewState`,
  `createNotesState`, `createFoldersState`, or `createViewState` inside
  `apps/honeycrisp/src/`.
- [ ] No call site destructures from `getSignedInSession().state`.
- [ ] No call site inlines `getSignedInSession()` into a template or
  event handler.
- [ ] Typecheck passes (`bun run typecheck` or equivalent).
- [ ] Manual smoke (Wave 5) succeeds for every listed flow.
- [ ] JSDoc examples in the three state files and in
  `session.svelte.ts` show only the new names.

## References

- `apps/honeycrisp/src/lib/session.svelte.ts` (signed-in shape, JSDoc rules)
- `apps/honeycrisp/src/routes/(signed-in)/state/index.ts`
- `apps/honeycrisp/src/routes/(signed-in)/state/folders.svelte.ts`
- `apps/honeycrisp/src/routes/(signed-in)/state/notes.svelte.ts`
- `apps/honeycrisp/src/routes/(signed-in)/state/view.svelte.ts`
- `apps/honeycrisp/src/routes/(signed-in)/state/search-params.svelte.ts`
- `apps/honeycrisp/src/routes/(signed-in)/+page.svelte`
- `apps/honeycrisp/src/routes/(signed-in)/components/*.svelte`
- Memory: `feedback_no_destructure_reactive.md`
  (bind once, never destructure reactive accessors)
- Skill: `cohesive-clean-breaks` (no aliases, no hybrid surface)
