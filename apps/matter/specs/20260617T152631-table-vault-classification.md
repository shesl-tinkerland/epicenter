# Table/vault classification: altitude is shape, `matter.json` only types

A folder of folders is a vault; a folder of files is a table. That one rule decides
altitude for both surfaces (the CLI loader `loadPath` and the GUI watcher `scan_vault`).
`matter.json` only TYPES the table it sits in; it never decides altitude. This supersedes
the classification rule recorded in the Edge Cases of
`20260616T075253-vault-as-relational-unit.md` (which let a `matter.json` at the root make
the root the one table, even over child folders).

## Decision

```
Has a visible child folder?  ->  VAULT   (each child folder is a table, sorted; loose files ignored)
Otherwise                    ->  TABLE   (its .md are rows; matter.json, if present, types it)
```

Three nouns, nothing else:

- a **row** is a `.md` file;
- a **table** is a *leaf* folder of rows, plus an optional `matter.json` contract that types it;
- a **vault** is one reference-resolution scope: a *branch* folder whose child folders are
  tables, or a leaf opened directly (a degenerate vault of one).

A vault is not "a folder of folders." A vault is the boundary inside which references
(`adaptations.page -> pages`) resolve. "Folder of folders" is just how that scope lands on
disk. This is why the rule is what it is, and why every refusal below is principled rather
than a preference.

### What follows from the rule

- **`matter.json` is orthogonal to altitude.** It types a leaf. At a vault altitude (a folder
  of folders) it has no table to type, so it is an inert file. A contract can never hide child
  tables.
- **A matter table is flat.** Its `.md` files are its rows; it has no subfolders. A subfolder
  always means "a level down" (a table of the enclosing vault), never "an attachment." Per-table
  attachments are deliberately not a matter concept.
- **No recursion.** A vault is one flat scope. Depth is a *different* scope, reached by opening
  that folder, not by walking the tree. (Refuse the tree-walker.)
- **Hidden directories (`.git`, `.obsidian`) are not tables.** They are skipped when counting
  child folders and when listing a vault's tables.
- **Empty folder -> table.** No child folder means a table (with zero rows): the zero state.
- **Loose `.md` at a vault root (a `README.md`) are ignored.** A row exists only inside a table,
  so a file at the vault altitude is a document, not a row. Nothing is lost.

### One rule, both surfaces

The CLI loader (`src/lib/load/fs.ts` `loadPath`) and the GUI watcher
(`src-tauri/src/watch.rs` `scan_vault`) implement the same rule in two languages. A shared set
of fixture cases is pinned in both `fs.test.ts` and the `watch.rs` tests so the two cannot
drift. The `scope: 'table' | 'vault'` that `loadPath` returns (and the CLI emits in `--json`)
is exactly this shape bit surfaced: `scope === 'table'` means the opened folder was itself a
leaf, so its references have no sibling tables loaded and are reported as un-evaluable rather
than failing.

## Considered options

- **Keep the contract as the altitude signal (the prior rule).** Rejected. It overloads
  `matter.json` to mean both "typed" and "this folder is a table, subfolders are its
  attachments," and it carries a silent-data-loss footgun: a `matter.json` dropped at a vault
  root collapses the whole vault to one table and hides the child tables. The benign case it
  buys (a table with an `attachments/` subfolder) is speculative: zero example vaults use it and
  no spec defines it.

- **An explicit `vault.json` manifest.** Rejected. A second source of truth that must be kept in
  sync with disk, with the classic "manifest lists a table that is not there / disk has a table
  the manifest omits" drift. Membership is derivable from disk; a manifest earns its keep only
  for ordering, exclusions, or remote tables, none of which matter needs. The vault declares
  nothing; it is the live union of its tables' self-declared contracts.

- **A mandatory `tables/` workspace layout.** Rejected. Trades a file-presence heuristic for a
  folder-name heuristic that is just as arbitrary, and forfeits "point matter at any folder of
  markdown," which is the product. It also breaks `matter check ./customers` on a bare table.

- **Require `matter.json` for a folder to be a table.** Rejected. Deletes the untyped table (the
  raw grid) and the empty-folder zero state, which are the no-ceremony heart of the product.

## Assets are not a system

A flat table cannot hold a subfolder, so "where do images and other binaries go?" is a fair
question. The greenfield answer is to refuse it as a matter concern. matter models exactly two
visible filesystem shapes (a folder of folders, a folder of `.md` files) and nothing else;
assets are "everything else," and they fall out of the rules already locked above for free:

- **Per-table asset:** drop the file directly in the table folder. A non-`.md` file is a loose
  file, ignored (not a row), exactly like a `notes.txt`. The row references it by a relative path
  (`./diagram.png`). Flatness is preserved because a file never makes a vault.
- **Vault-shared asset:** put it in a hidden folder (`.assets/`). Classification skips hidden
  directories, so it lives inside the vault without becoming a table; the row references
  `../.assets/diagram.png`. Or keep assets entirely outside the vault.
- **Remote asset:** a URL string in the markdown or frontmatter. matter never touches it.

In all three, matter stores nothing, names nothing, tracks nothing, and garbage-collects nothing.
There is no asset table, no asset registry, no asset folder convention to enforce.

**matter does not validate that a referenced asset exists.** Integrity is cross-table reference
resolution and nothing else. A reference resolves inside the loaded vault: the vault is a closed
universe already in memory. An asset path resolves against an open universe (arbitrary relative
or absolute paths, URLs, templated strings) that matter has not loaded and cannot bound. That
asymmetry, closed vs open universe, is exactly why references belong in the integrity model and
assets do not. If broken-asset checking is ever wanted, it is a separate linter over markdown
bodies, not part of integrity.

The asymmetric win: one refusal (matter is not an asset manager) deletes an entire category of
would-be design surface (asset storage location, asset-existence checks, asset GC, the
"is this folder assets or a table" ambiguity), and it costs nothing real, because every asset
placement a user could want is already expressible through rules matter already has.

## Consequences

This is a greenfield clean break: there is no published on-disk contract and the GUI/CLI
classifier had just been unified in `5f0dfb5a1`, so both surfaces move in one change.

- `loadPath` and `scan_vault` drop `matter.json` from the altitude decision and skip hidden
  directories. `loadVault` skips hidden directories too.
- The behavior change: a folder with a `matter.json` *and* child folders now opens as a vault of
  those folders (it opened as a single table before). The `fs.test.ts` and `watch.rs` cases that
  pinned the old "a contract makes the root the one table even with subfolders" flip to "a
  contract never hides child tables."
- The deliberate boundary: a matter table is flat. A flat table that gains a subfolder opens as
  a vault, and its `.md` drop out of the grid until the subfolder is removed. This is reversible
  and visible, and matter owns no attachment concept for that subfolder. If per-table assets are
  ever needed, they are frontmatter paths to files outside the table folder, specified
  separately.
