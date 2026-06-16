# Fuji

Fuji is a local-first CMS where every entry's body is its own CRDT. Write offline, sync later, and collaborate on a single entry without touching the rest of your content. Think of it as a structured journal, knowledge base, or portfolio, whatever you tag and type your entries as.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo. MIT licensed.

---

## How it works

### Layout

SvelteKit app (static adapter, SSR disabled) with three panels: a sidebar for filtering by type, tags, and search; a main area that toggles between table and timeline views; and an editor panel for rich-text content.

### Data model

Workspace ID: `FUJI_ID` (`epicenter-fuji`). Rich-text content and entry metadata are separate CRDTs. The entries table stays lean: metadata rows live in the root Y.Doc, and each entry's body lives in the `entries.content` child doc declared by `fujiWorkspace`. The daemon-side Fuji mount still derives body snapshots with `entryContentDocGuid(id)` when rendering markdown. Loading a list of 500 entries doesn't mean loading 500 rich-text trees; the editor and the list never contend for the same document.

- `entries` table: `id` (EntryId), `title`, `subtitle`, `type` (string[]), `tags` (string[]), `pinned`, `deletedAt`, `date`, `dateZone`, `createdAt`, `updatedAt`, and `rating`.
- `entries.content`: per-entry rich-text child doc. `openFujiBrowser()` attaches storage and sync; `EntryBodyEditor.svelte` opens the active entry's content doc and bumps `updatedAt` on local editor changes.

### Client wiring

Fuji follows the repo-wide composition naming:

```txt
createWorkspace()
  low-level package primitive

fujiWorkspace
  Fuji's shared isomorphic definition: id, tables, actions, child docs

openFujiBrowser()
fuji()
  runtime-specific openers (browser connection, daemon mount factory)

defineWorkspace()
  builds the definition and owns .connect(...)
```

Fuji's browser workspace is built once per signed-in session by `createSession`. `openFujiBrowser()` opens `fujiWorkspace` with the signed-in browser connection, which attaches browser storage, root sync, and the `entries.content` child-doc runtime. The session module receives a `SignedIn` from `createSession` and passes it into the browser factory. `SignedIn` carries the stable owner, server URL, and auth transport functions.

```ts
import { openFujiBrowser } from "$lib/browser";
import { createSession } from "@epicenter/svelte/auth";
import { createNodeId } from "@epicenter/workspace";
import { auth } from "$lib/auth";

export const session = createSession({
  auth,
  build: (signedIn) =>
    openFujiBrowser({
      signedIn,
      nodeId: createNodeId({ storage: localStorage }),
    }),
});
```

Inside `openFujiBrowser`, the composition is now just the runtime connection:

```ts
export function openFujiBrowser({
  signedIn,
  nodeId,
}: {
  signedIn: SignedIn;
  nodeId: NodeId;
}) {
  return fujiWorkspace.connect({ ...signedIn, nodeId });
}
```

`fujiWorkspace` is the per-app definition built with `defineWorkspace({ id: FUJI_ID, tables: { entries: entriesTable }, kv, actions })`. The `actions` factory runs after tables are live, so handlers close over `tables.entries` without a second wrapping helper.

The browser bundle exposes concrete resources like `idb`, `collaboration`, and `tables.entries.docs.content.open(entryId)`. Auth state flows through `session.current`; when present, it carries the Fuji bundle, and pages reach it via the module-level `requireFuji()` exported from `$lib/session` (throws if called without an authenticated session). Local cleanup runs through `bundle.wipe()`, which destroys the live Y.Docs and then drops every IDB database for that owner. It is a separate explicit action, not part of sign-out.

For a sibling example of the same pattern with Tauri runtime wiring, see `apps/whispering/src/lib/whispering/whispering.tauri.ts`.

### Editor

ProseMirror with `y-prosemirror` binds directly to the entry's `Y.XmlFragment`. Edits are conflict-free by default; two sessions editing the same entry merge automatically.

### Keyboard shortcuts

- `Cmd+N`: new entry
- `Escape`: deselect current entry

---

## Development

Prerequisites: [Bun](https://bun.sh).

```bash
git clone https://github.com/EpicenterHQ/epicenter.git
cd epicenter
bun install
cd apps/fuji
bun dev
```

This starts the app dev server on port 5174. Auth and sync expect the local API on `localhost:8787`; start it from the repo root with `bun run dev:api`.

Fuji's mount is registered from the Epicenter root (the folder that holds `epicenter.config.ts`). It is not discovered from `.epicenter/` or any source folder. A folder that wants the Fuji mount needs an `epicenter.config.ts` like this:

```ts
import { fuji } from "@epicenter/fuji/mount";

export default fuji();
```

`fuji()` returns a `Mount` whose `name` is `fuji`; `Mount.name` is the CLI prefix. `epicenter.config.ts` default-exports one mount. Disk paths follow the app-folder layout: the read-only markdown projection lands in table-named generated folders such as `<epicenterRoot>/entries/`, while the guid-keyed SQLite mirror stays under `.epicenter/sqlite/<id>.db` (hidden). The materialized `.md` is read-only; mutate entries through actions (`epicenter run fuji.<action>`), never by editing the files.

`epicenter daemon up -C <epicenter-root>` starts the mount declared in `epicenter.config.ts`. It creates `.epicenter/` for generated machine state when it is missing, but sockets and daemon logs live in platform user paths instead of inside the root.

---

## Tech stack

- [SvelteKit](https://kit.svelte.dev): UI framework (static adapter, SSR disabled)
- [ProseMirror](https://prosemirror.net) + [y-prosemirror](https://github.com/yjs/y-prosemirror): collaborative rich-text editing
- [TanStack Svelte Table](https://tanstack.com/table): entry list table view
- [Yjs](https://yjs.dev): CRDT engine
- [Tailwind CSS](https://tailwindcss.com): styling
- `@epicenter/workspace`: CRDT-backed tables, versioning, documents
- `@epicenter/svelte`: workspace gate, reactive table/KV bindings, and the Svelte 5 auth wrapper around `@epicenter/auth` via the `@epicenter/svelte/auth` subpath
- `@epicenter/ui`: shadcn-svelte component library

---

## License

MIT
