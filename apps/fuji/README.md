# Fuji

Fuji is a local-first CMS where every entry's body is its own CRDT. Write offline, sync later, and collaborate on a single entry without touching the rest of your content. Think of it as a structured journal, knowledge base, or portfolio, whatever you tag and type your entries as.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo. MIT licensed.

---

## How it works

### Layout

SvelteKit app (static adapter, SSR disabled) with three panels: a sidebar for filtering by type, tags, and search; a main area that toggles between table and timeline views; and an editor panel for rich-text content.

### Data model

Workspace ID: `epicenter.fuji`. Rich-text content and entry metadata are separate CRDTs. The entries table stays lean: just IDs, titles, tags, timestamps. Each entry's body lives in its own Y.Doc opened by a `createDisposableCache` keyed on the entry id; the child document builder owns the storage guid. Loading a list of 500 entries doesn't mean loading 500 rich-text trees; the editor and the list never contend for the same document.

- `entries` table: `id` (EntryId), `title`, `subtitle`, `type` (string[]), `tags` (string[]), `createdAt`, `updatedAt`, `_v`. Each entry's body is opened on demand from a disposable cache and bound to ProseMirror via `y-prosemirror`.
- KV keys: `selectedEntryId`, `viewMode` (`'table' | 'timeline'`), `sidebarCollapsed`.

### Client wiring

Fuji's root workspace is built once per signed-in session by `createSession`. `openFujiBrowser()` owns the `new Y.Doc(...)` call, composes every attachment inline, and returns the bundle directly. The session module receives a `LocalOwner` from `createSession` and passes it into the browser factory. The owner hides the subject to owner handoff and carries the lazy keyring reader. Sync opens sockets through auth on connection attempts, while encrypted stores keep the keyring derived when they attach.

```ts
export function openFujiBrowser({
  owner,
  replicaId,
  openWebSocket,
}: {
  owner: LocalOwner;
  replicaId: string;
  openWebSocket?: (
    url: string | URL,
    protocols?: string[],
  ) => WebSocket | Promise<WebSocket>;
}) {
  const rootYdoc = new Y.Doc({ guid: FUJI_WORKSPACE_ID, gc: false });
  const encryption = owner.attachEncryption(rootYdoc);
  const tables = encryption.attachTables(fujiTables);
  const kv = encryption.attachKv({});
  const idb = owner.attachIndexedDb(rootYdoc);
  owner.attachBroadcastChannel(rootYdoc);
  const actions = createFujiActions(tables);
  const collaboration = openCollaboration(rootYdoc, {
    url: roomWsUrl(APP_URLS.API, rootYdoc.guid),
    waitFor: idb.whenLoaded,
    openWebSocket,
    replicaId,
    actions,
  });
  return { ydoc: rootYdoc, tables, kv, idb, collaboration };
}
```

The browser bundle exposes concrete resources like `idb`, `collaboration`, and child document collections. Auth state flows through `session.current`; when present, it carries the app binding, and pages reach it via the module-level `requireApp()` exported from `$lib/session` (throws if called without an authenticated session). Local cleanup is a separate explicit action, not part of sign-out.

For a sibling example of the same pattern (plus a Tauri-side materializer), see `apps/whispering/src/lib/whispering/client.ts`.

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
