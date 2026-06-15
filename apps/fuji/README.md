# Fuji

Fuji is a local-first CMS where every entry's body is its own CRDT. Write offline, sync later, and collaborate on a single entry without touching the rest of your content. Think of it as a structured journal, knowledge base, or portfolio, whatever you tag and type your entries as.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo. MIT licensed.

---

## How it works

### Layout

SvelteKit app (static adapter, SSR disabled) with three panels: a sidebar for filtering by type, tags, and search; a main area that toggles between table and timeline views; and an editor panel for rich-text content.

### Data model

Workspace ID: `FUJI_ID` (`epicenter-fuji`). Rich-text content and entry metadata are separate CRDTs. The entries table stays lean: metadata rows live in the root Y.Doc, and each entry's body lives in its own child Y.Doc addressed by `entryContentDocGuid(id)`. The browser opens bodies through a `createDisposableCache` keyed on the entry id; the daemon-side Fuji mount opens a throwaway body doc per row when deriving markdown. Loading a list of 500 entries doesn't mean loading 500 rich-text trees; the editor and the list never contend for the same document.

- `entries` table: `id` (EntryId), `title`, `subtitle`, `type` (string[]), `tags` (string[]), `pinned`, `deletedAt`, `date`, `dateZone`, `createdAt`, `updatedAt`, and `rating`.
- `entryBodies`: browser child-doc cache. `entryContentDocGuid(id)` defines the Y.Doc identity; `openFujiBrowser()` attaches rich text, storage, sync, and the `updatedAt` bump.

### Client wiring

Fuji follows the repo-wide composition naming:

```txt
createWorkspace()
  low-level package primitive

createFuji()
  Fuji's shared isomorphic model: id, tables, actions

openFujiBrowser()
fuji()
  runtime-specific wiring (browser opener, daemon mount factory)

defineWorkspace()
  preserves the inferred bundle shape after composition
```

Fuji's browser workspace is built once per signed-in session by `createSession`. `openFujiBrowser()` calls `createFuji({ keyring })`, attaches browser storage and sync, then builds `entryBodies`, the app-owned cache for entry content docs. The session module receives a `SignedIn` from `createSession` and passes it into the browser factory. `SignedIn` carries the stable owner, keyring reader, server URL, and auth transport functions.

```ts
import { openFujiBrowser } from "$lib/browser";
import { createSession } from "@epicenter/svelte/auth";
import { createDeviceId } from "@epicenter/workspace";
import { auth } from "$lib/auth";

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
  const workspace = createFuji({ keyring: signedIn.keyring });

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
  const entryBodies = createDisposableCache((id: EntryId) => {
    const ydoc = new Y.Doc({ guid: entryContentDocGuid(id), gc: true });
    const { idb: bodyIdb } = wire(ydoc, {});
    const body = attachRichText(ydoc);
    const offLocalUpdate = onLocalUpdate(ydoc, () =>
      workspace.tables.entries.update(id, { updatedAt: DateTimeString.now() }),
    );
    return {
      ydoc,
      binding: body.binding,
      read: body.read,
      write: body.write,
      whenLoaded: bodyIdb.whenLoaded,
      [Symbol.dispose]() {
        offLocalUpdate();
        ydoc.destroy();
      },
    };
  });
  return { ...workspace, idb, collaboration, /* ... */ };
}
```

`createFuji({ keyring })` is the per-app helper that wraps `createWorkspace({ id: FUJI_ID, keyring, tables: { entries: entriesTable }, kv })`, adds `workspace.actions`, and returns the standard `{ ydoc, tables, kv, actions, [Symbol.dispose] }` bundle through `defineWorkspace()`.

The browser bundle exposes concrete resources like `idb`, `collaboration`, and `entryBodies`. Auth state flows through `session.current`; when present, it carries the Fuji bundle, and pages reach it via the module-level `requireFuji()` exported from `$lib/session` (throws if called without an authenticated session). Local cleanup runs through `bundle.wipe()`, which destroys the live Y.Docs and then calls `wipeLocalStorage({ server: signedIn.server, ownerId: signedIn.ownerId })` to drop every encrypted IDB database for that owner. It is a separate explicit action, not part of sign-out.

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
import { fuji } from "@epicenter/fuji/project";

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
