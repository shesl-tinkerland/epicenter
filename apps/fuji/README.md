# Fuji

Fuji is a local-first CMS where every entry's body is its own CRDT. Write offline, sync later, and collaborate on a single entry without touching the rest of your content. Think of it as a structured journal, knowledge base, or portfolio, whatever you tag and type your entries as.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo. MIT licensed.

---

## How it works

### Layout

SvelteKit app (static adapter, SSR disabled) with three panels: a sidebar for filtering by type, tags, and search; a main area that toggles between table and timeline views; and an editor panel for rich-text content.

### Data model

Workspace ID: `FUJI_ID` (`epicenter.fuji`). Rich-text content and entry metadata are separate CRDTs. The entries table stays lean: metadata rows live in the root Y.Doc, and each entry's body lives in its own child Y.Doc opened by a `createDisposableCache` keyed on the entry id. Loading a list of 500 entries doesn't mean loading 500 rich-text trees; the editor and the list never contend for the same document.

- `entries` table: `id` (EntryId), `title`, `subtitle`, `type` (string[]), `tags` (string[]), `pinned`, `deletedAt`, `date`, `dateZone`, `createdAt`, `updatedAt`, and `rating`.
- `entryContentDocs`: shared child-doc cache. `createFujiWorkspace()` defines the child Y.Doc identity and rich-text model; runtime openers attach storage and sync around those docs.

### Client wiring

Fuji follows the repo-wide composition naming:

```txt
createWorkspace()
  low-level package primitive

createFujiWorkspace()
  Fuji's shared isomorphic model: id, tables, actions, child docs

openFujiBrowser()
fuji()
  runtime-specific wiring (browser opener, project mount factory)

defineWorkspace()
  preserves the inferred bundle shape after composition
```

Fuji's browser workspace is built once per signed-in session by `createSession`. `openFujiBrowser()` calls `createFujiWorkspace({ keyring })`, attaches browser storage and sync, then wraps the shared child docs with child-doc storage and sync. The session module receives a `SignedIn` from `createSession` and passes it into the browser factory. `SignedIn` carries the stable owner, keyring reader, server URL, and auth transport functions.

```ts
import { openFujiBrowser } from '$lib/browser';
import { createSession } from '@epicenter/svelte';
import { createDeviceId } from '@epicenter/workspace';
import { auth } from '$lib/auth';

export const session = createSession({
  auth,
  build: (signedIn) =>
    openFujiBrowser({
      signedIn,
      deviceId: createDeviceId({ storage: localStorage }),
    }),
});
```

Inside `openFujiBrowser`, the composition is fully visible top-to-bottom:

```ts
export function openFujiBrowser({
  signedIn,
  deviceId,
}: {
  signedIn: SignedIn;
  deviceId: DeviceId;
}) {
  const workspace = createFujiWorkspace({ keyring: signedIn.keyring });

  const idb = attachLocalStorage(workspace.ydoc, {
    server: signedIn.server,
    ownerId: signedIn.ownerId,
    keyring: signedIn.keyring,
  });
  const collaboration = openCollaboration(workspace.ydoc, {
    url: roomWsUrl({
      baseURL: signedIn.baseURL,
      ownerId: signedIn.ownerId,
      guid: workspace.ydoc.guid,
      deviceId,
    }),
    openWebSocket: signedIn.openWebSocket,
    onReconnectSignal: signedIn.onReconnectSignal,
    waitFor: idb.whenLoaded,
    actions: workspace.actions,
  });
  // ... per-entry child docs, wipe(), dispose
  return { ...workspace, idb, collaboration, /* ... */ };
}
```

`createFujiWorkspace({ keyring })` is the per-app helper that wraps `createWorkspace({ id: FUJI_ID, keyring, tables: fujiTables, kv })`, adds `workspace.actions`, adds `entryContentDocs`, and returns the standard `{ ydoc, tables, kv, actions, entryContentDocs, [Symbol.dispose] }` bundle through `defineWorkspace()`.

The browser bundle exposes concrete resources like `idb`, `collaboration`, and child document collections. Auth state flows through `session.current`; when present, it carries the Fuji bundle, and pages reach it via the module-level `requireFuji()` exported from `$lib/session` (throws if called without an authenticated session). Local cleanup runs through `bundle.wipe()`, which destroys the live Y.Docs and then calls `wipeLocalStorage({ server: signedIn.server, ownerId: signedIn.ownerId })` to drop every encrypted IDB database for that owner. It is a separate explicit action, not part of sign-out.

For a sibling example of the same pattern with Tauri runtime wiring, see `apps/whispering/src/lib/whispering/tauri.ts`.

### Editor

ProseMirror with `y-prosemirror` binds directly to the entry's `Y.Text`. Edits are conflict-free by default; two sessions editing the same entry merge automatically.

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

Fuji's mount is registered from the project root. It is not discovered from `.epicenter/` or any source folder. A project that wants the Fuji mount needs an `epicenter.config.ts` like this:

```ts
import { fuji } from '@epicenter/fuji/project';

export default fuji();
```

`fuji()` is a factory that returns a `Mount` carrying its own canonical name (`fuji`). Pass options to override defaults (`fuji({ markdownDir: '.', sqliteFile: '.epicenter/sqlite.db' })`).

`epicenter daemon up -C <project>` starts every mount declared in `epicenter.config.ts` inside one daemon process. It creates `.epicenter/` for generated project data when it is missing, but sockets and daemon logs live in platform user paths instead of inside the project.

---

## Tech stack

- [SvelteKit](https://kit.svelte.dev): UI framework (static adapter, SSR disabled)
- [ProseMirror](https://prosemirror.net) + [y-prosemirror](https://github.com/yjs/y-prosemirror): collaborative rich-text editing
- [TanStack Svelte Table](https://tanstack.com/table): entry list table view
- [Yjs](https://yjs.dev): CRDT engine
- [Tailwind CSS](https://tailwindcss.com): styling
- `@epicenter/workspace`: CRDT-backed tables, versioning, documents
- `@epicenter/auth-svelte`: Svelte 5 wrapper around `@epicenter/auth`
- `@epicenter/svelte`: workspace gate and reactive table/KV bindings
- `@epicenter/ui`: shadcn-svelte component library

---

## License

MIT
