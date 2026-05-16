# Epicenter: YJS-First Collaborative Workspace System

The hard problem with local-first apps is synchronization. If each device has its own SQLite file, how do you keep them in sync? If each device has its own markdown folder, same question.

`@epicenter/workspace` solves that by making Yjs the source of truth. Tables, KV entries, document content, and awareness all live in a `Y.Doc`; persistence, sync, and materializers hang off that core as attachment primitives. Write to the workspace, and everything else reacts.

The public path is a small set of `attach*` primitives that you compose inline
around `new Y.Doc`. Browser apps with many child Y.Docs use
`createDisposableCache(...)` to share live child documents. Browser storage
cleanup stays in app-owned helper functions that already know the parent table
and child document guid policy.

## Quick Start

```bash
bun add @epicenter/workspace
```

```typescript
import { type } from 'arktype';
import * as Y from 'yjs';
import {
	attachIndexedDb,
	attachKv,
	attachTables,
	attachYjsSync,
	defineTable,
	websocketUrl,
} from '@epicenter/workspace';

const posts = defineTable(
	type({
		id: 'string',
		title: 'string',
		body: 'string',
		published: 'boolean',
		_v: '1',
	}),
);

export function openBlog() {
	const ydoc = new Y.Doc({ guid: 'epicenter.blog' });
	const tables = attachTables(ydoc, { posts });
	const kv = attachKv(ydoc, {});
	const idb = attachIndexedDb(ydoc);
	const sync = attachYjsSync(ydoc, {
		url: websocketUrl(`http://localhost:3913/rooms/${ydoc.guid}`),
		waitFor: idb.whenLoaded,
	});

	return {
		get id() {
			return ydoc.guid;
		},
		ydoc,
		tables,
		kv,
		idb,
		sync,
		batch: (fn: () => void) => ydoc.transact(fn),
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}

// Singleton style: open once at module scope, use everywhere.
export const blog = openBlog();

async function quickStart() {
	await blog.idb.whenLoaded;

	blog.tables.posts.set({
		id: 'welcome',
		title: 'Hello World',
		body: 'This row lives in the Y.Doc.',
		published: false,
		_v: 1,
	});

	const result = blog.tables.posts.get('welcome');
	if (result.status === 'valid') {
		blog.tables.posts.update(result.row.id, { published: true });
	}
}

void quickStart;
```

That example uses the current public API end to end:

- `defineTable(...)` with a real schema
- a direct `openBlog()` builder function that owns `new Y.Doc` and returns the bundle
- `attachTables` / `attachKv` / `attachIndexedDb` / `attachYjsSync` composed inline
- direct property access via `blog.tables.posts`
- `set`, `get`, `update`, `delete`, `getAllValid`, and `observe`

Singleton apps (one workspace per app) call a builder like `openBlog()` once at
module scope. Browser child documents use `createDisposableCache(...)`.
One-shot Node scripts can open a child document directly for one operation;
daemon and materializer workloads can opt into `createDisposableCache(...)` when
same-process reuse matters. See [Per-row content documents](#per-row-content-documents)
below.

## Prefix vocabulary

Every exported function in this package falls into one of three verbs. The prefix tells you what the function *does to state*:

| Verb | Side effect | Input | Output | Examples |
|---|---|---|---|---|
| `define*` | **None**: pure data | Schemas, defaults | Plain config object | `defineTable`, `defineKv`, `defineMutation`, `defineQuery` |
| `attach*` | **Mutates a Y.Doc**: binds a slot, registers `ydoc.on('destroy')` | An existing `Y.Doc` + config | Typed handle, non-idempotent, hold the reference | `attachTable`, `attachTables`, `attachKv`, `attachRichText`, `attachPlainText`, `attachTimeline`, `attachAwareness`, `attachIndexedDb`, `attachYjsLog`, `attachBroadcastChannel`, `attachOwnedBroadcastChannel`, `attachYjsSync`, `attachEncryption` (with `.attachTable` / `.attachTables` / `.attachKv` methods), `attachMarkdownMaterializer`, `attachSqliteMaterializer` |
| `create*` | **Pure construction**: no listeners, no subscriptions, no destroy registration at call time. | Definitions or a builder closure | A usable definition or cache | `createDisposableCache` |
| `open*` | **Opens a runtime over a Y.Doc or a local resource**: returns a typed handle with its own teardown. The Y.Doc-bound case (`openCollaboration`) registers `ydoc.on('destroy')` like `attach*` does; the resource case (`openSqliteReader`) takes no Y.Doc and returns a `[Symbol.dispose]()` handle. | Y.Doc + config, or resource config | Typed runtime handle | `openCollaboration`, `openSqliteReader`, `openWriterSqlite` |

`createDisposableCache(build, opts?)` is the refcounted cache primitive. The
user owns construction; the cache owns identity keyed by id,
refcounting, and the `gcTime` grace period between last dispose and teardown.
`.open(id)` returns a disposable handle.

### Plaintext vs encrypted

Both variants ship from this package. Plaintext (`attachTable`, `attachTables`, `attachKv`) binds a typed helper directly to the Y.Doc. Encrypted: the methods on the `EncryptionAttachment` coordinator returned by `attachEncryption(ydoc, { keyring })` (`encryption.attachTable`, `encryption.attachTables`, `encryption.attachKv`) additionally register their backing store with that coordinator. The coordinator reads `keyring()` synchronously at each registration site, derives the per-workspace keyring, and activates the store before handing it back. Already-attached encrypted stores keep their derived keyring; same-subject key rotation needs a re-attach to affect those stores.

Don't mix plaintext and encrypted wrappers on the same slot name: Yjs hands both calls the same underlying `Y.Array` and you get a silent plaintext-over-ciphertext race. The verb (`encryption.attachTable` vs plain `attachTable`) is the primary defense; review call sites accordingly. One slot name, one attach site, one intent.

Minimal encrypted workspace: encryption + IndexedDB + cross-tab + collaboration (sync + presence + RPC) wired end-to-end:

```typescript
import {
	attachEncryption,
	createLocalOwner,
	openCollaboration,
	type Replica,
	roomWsUrl,
} from '@epicenter/workspace';
import type { SubjectKeyring } from '@epicenter/encryption';
import * as Y from 'yjs';
import { appTables } from '$lib/workspace/definition';

export function openApp({
	ownerId,
	replica,
	openWebSocket,
	keyring,
}: {
	ownerId: string;
	replica: Replica;
	openWebSocket?: (
		url: string | URL,
		protocols?: string[],
	) => WebSocket | Promise<WebSocket>;
	keyring: () => SubjectKeyring;
}) {
	const ydoc = new Y.Doc({ guid: 'epicenter.my-app', gc: false });

	const owner = createLocalOwner({ ownerId, keyring });
	const encryption = attachEncryption(ydoc, { keyring });
	const tables = encryption.attachTables(appTables);

	const idb = owner.attachIndexedDb(ydoc);
	owner.attachBroadcastChannel(ydoc);

	const collaboration = openCollaboration(ydoc, {
		url: roomWsUrl('https://api.epicenter.so', ydoc.guid),
		waitFor: idb.whenLoaded,
		openWebSocket,
		replica,
		actions: {},
	});

	return {
		get id() {
			return ydoc.guid;
		},
		ydoc,
		tables,
		encryption,
		idb,
		collaboration,
		batch: (fn: () => void) => ydoc.transact(fn),
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}

export const workspace = openApp({
	subject,
	replica: { id: 'macbook', platform: 'tauri' },
	openWebSocket: auth.openWebSocket,
	keyring: () => {
		if (auth.state.status === 'signed-out') {
			throw new Error('[workspace] auth signed-out.');
		}
		return auth.state.localIdentity.keyring;
	},
});
```

`openCollaboration` is the workspace primitive: it wraps the sync supervisor, publishes the local replica in awareness, dispatches inbound action and runtime requests, and exposes a `peers` surface (`workspace.collaboration.peers.find(replicaId)?.invoke('path', input)`). For content documents that need bytes-only sync (no presence, no RPC), use the sibling primitive `attachYjsSync(ydoc, { url, ... })`. See [SYNC_ARCHITECTURE.md](./SYNC_ARCHITECTURE.md) for the full model.

The `guid` you pass to `new Y.Doc(...)` becomes `ydoc.guid`, which becomes the sync room name. Namespace it to your app (e.g. `epicenter.my-app`) to avoid collisions when multiple apps share the same IndexedDB origin.

For production-shaped browser wiring, see `apps/fuji/src/routes/(signed-in)/fuji/browser.ts`. For auth session transitions, see `apps/fuji/src/lib/session.svelte.ts`.

## Core Philosophy

### Yjs is the source of truth

Epicenter keeps the write path brutally simple: the `Y.Doc` is authoritative. Tables and KV are just typed helpers over Yjs collections, and document content is a Yjs timeline. Sync providers, SQLite mirrors, and markdown files are all derived from that core.

That matters because conflict resolution only has to happen once. Yjs handles merge semantics; extensions react to the merged state.

### Definitions are pure; builders are live

`defineTable` and `defineKv` are pure. They do not create a `Y.Doc`, open a
socket, or touch IndexedDB. The builder function you write, whether you call it
directly for a singleton or from a browser document cache, is the boundary
where the live bundle appears.

That split is not cosmetic. It lets you share definitions across modules, infer types once, and instantiate different bundles in different runtimes without rewriting the schema layer.

### Inline composition is the extension system

There is no builder chain. A user-owned builder function composes attachments inline:

```typescript
function openBlog() {
	const ydoc = new Y.Doc({ guid: 'epicenter.blog' });
	const tables = attachTables(ydoc, { posts });
	const idb = attachIndexedDb(ydoc);
	const sync = attachYjsSync(ydoc, { url, waitFor: idb.whenLoaded });
	return {
		get id() { return ydoc.guid; },
		ydoc, tables, idb, sync,
		[Symbol.dispose]() { ydoc.destroy(); },
	};
}
```

Ordering is obvious (later `attach*` calls see earlier ones through plain lexical scope) and there is no magic `client.extensions` namespace: each attachment is whatever you named it in the returned bundle.

### Read-time validation beats write-time ceremony

Tables validate and migrate on read, not on write. `set(...)` writes the row shape TypeScript already approved. `get(...)` is where invalid old data shows up as `{ status: 'invalid' }` and old versions are migrated to the latest schema.

That trade-off is deliberate. It keeps the write path cheap and pushes schema evolution into one place:the table definition.

### Storage scales with active data, not edit history

With Yjs garbage collection enabled, storage tracks the live document much more closely than the number of operations that happened over time. Deleted rows, overwritten values, and old content states collapse down to compact metadata. The workspace grows because you keep more data:not because you clicked save a thousand times.

## Architecture Overview

### The Y.Doc: Heart of Every Workspace

Every piece of data lives in a `Y.Doc`, which provides conflict-free merging, real-time collaboration, and offline-first operation:

```
┌─────────────────────────────────────────────────────────────┐
│                      Y.Doc (CRDT)                            │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Y.Array('table:posts')  <- LWW entries per table      │  │
│  │   └── { key: id, val: { fields... }, ts: number }     │  │
│  │                                                        │  │
│  │ Y.Array('table:users')  <- Another table              │  │
│  │   └── { key: id, val: { fields... }, ts: number }     │  │
│  │                                                        │  │
│  │ Y.Array('kv')  <- Settings as LWW entries             │  │
│  │   └── { key: name, val: value, ts: number }           │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘

Note: Schema definitions are stored in static TypeScript modules, not in the Y.Doc.
The Y.Doc carries data. Your definition files carry meaning.
```

### Three-Layer Data Flow

```
┌────────────────────────────────────────────────────────────────────┐
│  WRITE FLOW                                                         │
│                                                                     │
│  App code / action → Y.Doc updated → Extensions react              │
│                       │                                             │
│              ┌────────┼────────┐                                    │
│              ▼        ▼        ▼                                    │
│         IndexedDB  WebSocket  Markdown                              │
│         or SQLite   sync      materializer                          │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│  READ FLOW                                                          │
│                                                                     │
│  Simple reads → table / kv helpers over Y.Doc                       │
│  Rich text  → document handles over timeline Y.Docs                 │
│  Derived reads → extension exports built on the same core           │
└────────────────────────────────────────────────────────────────────┘
```

### Multi-Device Sync Topology

Epicenter supports distributed sync where Y.Doc instances replicate across devices via y-websocket:

```
   PHONE                   LAPTOP                    DESKTOP
   ┌──────────┐           ┌──────────┐              ┌──────────┐
   │ Browser  │           │ Browser  │              │ Browser  │
   │ Y.Doc    │           │ Y.Doc    │              │ Y.Doc    │
   └────┬─────┘           └────┬─────┘              └────┬─────┘
        │                      │                         │
   (no server)            ┌────▼─────┐              ┌────▼─────┐
        │                 │ Elysia   │◄────────────►│ Elysia   │
        │                 │ :3913    │  server-to-  │ :3913    │
        │                 └────┬─────┘    server    └────┬─────┘
        │                      │                         │
        └──────────────────────┴─────────────────────────┘
                           Connect to multiple nodes
```

Yjs supports multiple providers simultaneously. A phone can connect to desktop, laptop, and cloud at the same time; CRDT merge semantics do the rest.

### How It All Fits Together

1. Define tables and KV entries with `defineTable` and `defineKv`.
2. Write a builder function that constructs `new Y.Doc({ guid })` and composes `attachTables` / `attachKv` / `attachIndexedDb` / `openCollaboration` (or `attachYjsSync` for content docs) inline, returning the bundle.
3. For singleton apps: call the builder once at module scope. For browser
   child documents: use `createDisposableCache(...)` and call `.open(rowId)`
   per instance. For one-shot Node operations: call the child builder directly
   inside `using`.
4. Await the right readiness signal before reading persisted state. There are two shapes here, and the choice is load-bearing:
   - **One subsystem to wait on.** Expose the subsystem (`idb`, `persistence`, ...) on the bundle root and let consumers reach through: `await bundle.idb.whenLoaded`. Do not alias `whenLoaded`/`whenReady` flat at the bundle root just to save a `.idb`; the alias lies about composition.
   - **Two or more subsystems to compose into one barrier.** Then `whenReady` earns its place: `whenReady: Promise.all([persistence.whenLoaded, unlock.whenChecked, sync.whenConnected])`. Because the field is typed `Promise<unknown>`, `Promise.all([...])` is assignable directly. Consumers `await bundle.whenReady`. The CLI's `run` command, migrations, `@epicenter/filesystem` ops, the sqlite-index materializer, and `{#await}` gates in editors all consume this aggregate.

   See `specs/20260506T020000-expose-attachments-not-aliases.md` for the rule and anti-patterns.
5. Read and write through `bundle.tables`, `bundle.kv`, `bundle.collaboration.peers` (for cross-peer dispatch), and (for per-row content docs) whatever you exposed in the returned bundle.
6. Iterate `Object.entries(bundle.actions)` and read each action's metadata (`type`, `title`, `description`, `input`) if you want to build adapters such as HTTP, CLI, or MCP.
7. Dispose with `bundle[Symbol.dispose]()` for singletons or `handle[Symbol.dispose]()` for cache handles when you're done. Use `cache[Symbol.dispose]()` to flush every live entry.

The architecture stays local-first: the workspace works offline, synchronizes opportunistically, and treats external systems as helpers around the document, not the other way around.

## Shared Workspace ID Convention

Epicenter uses stable, shared workspace IDs so multiple apps can collaborate on the same data.

- Format: `epicenter.<app>`
- Purpose: stable routing, persistence keys, sync room names, and workspace discovery
- Stability: once published, an ID should not change
- Scope: two apps with the same ID are intentionally pointing at the same workspace

The ID becomes `ydoc.guid` for the workspace doc, so it is not a throwaway string. Pick one and keep it.

## Core Concepts

### Workspaces

A workspace is a `Y.Doc` plus whatever `attach*` handles you bound to it,
packaged as a bundle with `{ id, ydoc, [Symbol.dispose], ... }`. A browser
workspace also exposes `wipe()`. A singleton app returns the bundle
from a top-level function like `openBlog()`. A document cache returns disposable
handles over child documents keyed by row id.

### Yjs document

The raw `Y.Doc` is available at `bundle.ydoc`. That is the escape hatch, not the primary API. Most consumers should stay at the typed-helper layer unless they are writing a new attachment or debugging storage internals.

### Tables

Tables are versioned row collections. Each row must include:

- `id: string`
- `_v: number`

At runtime, each table becomes a `Table` exposed as a direct property:

- `bundle.tables.posts.set(row)`
- `bundle.tables.posts.get(id)`
- `bundle.tables.posts.update(id, partial)`
- `bundle.tables.posts.delete(id)`

Table access is direct property access in the current API.

### KV

KV entries are for settings and scalar preferences. They are keyed by string and always return a valid value because invalid or missing data falls back to the definition's default.

- `bundle.kv.get('theme.mode')`
- `bundle.kv.set('theme.mode', 'dark')`
- `bundle.kv.observe('theme.mode', ...)`

### Attachments (the extension system)

"Extensions" in Epicenter are just `attach*` calls inside your builder function. There is no `.withExtension` chain, no extension registry, no priority flag: just lexical scope.

- Call the relevant `attach*` or `open*` function (e.g. `attachIndexedDb`, `attachYjsSync`, `attachYjsLog`, `attachEncryption`, `openCollaboration`) inside the builder and include the handle in the returned bundle.
- Order matters only through lexical scope: later `attach*` calls see earlier handles directly.
- For browser per-row content docs, write a separate `createDisposableCache(...)` and `.open(rowId)` it from the main workspace's actions or components.

### Actions

Actions are callable functions with metadata.

- `defineQuery(...)` creates a read action
- `defineMutation(...)` creates a write action
- Include them in your bundle as `actions: defineActions({...})` (typically via a `createMyAppActions({ tables, batch })` helper defined nearby). The helper enforces snake_case ASCII keys at compile time and runtime; consumers index by string or iterate with `Object.entries`.

Handlers close over `tables`, `kv`, and anything else the builder has in scope through normal JavaScript closure. They do not receive a framework context object.

### Per-row content documents

For browser apps where each row has its own rich-text / plain-text / timeline
content (files, notes, skills, entries), use
`createDisposableCache(...)` keyed by the row id. The main workspace holds
the metadata row; the cache owns live per-row content identity and refcounting.
App-local helper functions own local browser cleanup.

Each `.open(rowId)` returns a handle. Multiple consumers (editor, actions,
route transitions) can share one underlying Y.Doc safely; the cache owns
construction, refcounting, and `gcTime`-delayed teardown through the lower-level
cache primitive.

```svelte
<script lang="ts">
  import { fileContentDocs } from '$lib/client';

  let { fileId }: { fileId: string } = $props();

  const handle = $derived(fileContentDocs.open(fileId));
  $effect(() => () => handle[Symbol.dispose]());
</script>

<Editor ytext={handle.content} />
```

The `$derived` swaps handles when `fileId` changes; the `$effect` cleanup releases the old handle. Refcount 0 arms the cache's `gcTime` timer; a fresh open during the grace window cancels the pending teardown, so rapid navigation doesn't flap persistence or sync.

Reference implementations: `apps/opensidian/src/lib/opensidian/browser.ts`, `apps/skills/src/lib/skills/browser.ts`, `apps/fuji/src/routes/(signed-in)/fuji/browser.ts`, `apps/honeycrisp/src/routes/(signed-in)/honeycrisp/browser.ts`.

## Schema definition

### Required table fields

Every table row schema must include:

- `id`
- `_v`

In arktype, `_v: '1'` means the numeric literal `1`, not the string `'1'` at runtime.

### Single-version tables

```typescript
import { type } from 'arktype';
import { defineTable } from '@epicenter/workspace';

const users = defineTable(
	type({
		id: 'string',
		email: 'string',
		name: 'string',
		_v: '1',
	}),
);

void users;
```

Use the single-schema form when the table has only one version today.

### Versioned tables

```typescript
import { type } from 'arktype';
import { defineTable } from '@epicenter/workspace';

const posts = defineTable(
	type({
		id: 'string',
		title: 'string',
		_v: '1',
	}),
	type({
		id: 'string',
		title: 'string',
		slug: 'string',
		_v: '2',
	}),
).migrate((row) => {
		switch (row._v) {
			case 1:
				return {
					...row,
					slug: row.title.toLowerCase().replaceAll(' ', '-'),
					_v: 2,
				};

			case 2:
				return row;
		}
	});

void posts;
```

Migration runs on read. Old rows stay old in storage until you rewrite them.

### KV entries

```typescript
import { type } from 'arktype';
import { defineKv } from '@epicenter/workspace';

const themeMode = defineKv(type("'light' | 'dark' | 'system'"), 'light');
const sidebarWidth = defineKv(type('number'), 280);
const sidebarCollapsed = defineKv(type('boolean'), false);

void themeMode;
void sidebarWidth;
void sidebarCollapsed;
```

KV is validate-or-default. There is no migration function.

### Awareness schema

For the workspace's own replica + action keys, prefer `openCollaboration` (above): it owns an `Awareness` and publishes the standard fields. The `attachAwareness` primitive is the lower-level building block; reach for it when you need a separately-typed presence channel (for example, cursors on a content doc that doesn't participate in the collaboration RPC plane).

```typescript
import { type } from 'arktype';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import {
	attachAwareness,
	attachTables,
	defineTable,
} from '@epicenter/workspace';

const notes = defineTable(
	type({
		id: 'string',
		title: 'string',
		_v: '1',
	}),
);

function openNotes() {
	const ydoc = new Y.Doc({ guid: 'epicenter.notes' });
	const tables = attachTables(ydoc, { notes });
	const presence = attachAwareness(new Awareness(ydoc), {
		schema: {
			name: type('string'),
			color: type('string'),
			cursor: type({ line: 'number', column: 'number' }),
		},
		initial: {
			name: 'Braden',
			color: '#ff4d4f',
			cursor: { line: 0, column: 0 },
		},
	});

	return {
		get id() { return ydoc.guid; },
		ydoc,
		tables,
		presence,
		[Symbol.dispose]() { ydoc.destroy(); },
	};
}

const workspace = openNotes();

workspace.presence.setLocal({
	name: 'Braden',
	color: '#ff4d4f',
	cursor: { line: 12, column: 3 },
});
```

### Document-backed tables

Per-row content (one Y.Doc per file/note/entry) is a browser document cache
keyed by the row id in browser apps. The main workspace holds the metadata row;
the cache owns live content Y.Docs. App-local helpers own browser cleanup.
Node one-shot code can open the content document directly for one operation.

```typescript
import { type } from 'arktype';
import * as Y from 'yjs';
import {
	attachIndexedDb,
	attachPlainText,
	attachTables,
	createDisposableCache,
	defineTable,
	docGuid,
	onLocalUpdate,
} from '@epicenter/workspace';
import { clearDocument } from 'y-indexeddb';

const files = defineTable(
	type({
		id: 'string',
		name: 'string',
		updatedAt: 'number',
		_v: '1',
	}),
);

function openFilesWorkspace() {
	const ydoc = new Y.Doc({ guid: 'epicenter.files' });
	const tables = attachTables(ydoc, { files });
	const idb = attachIndexedDb(ydoc);
	return {
		get id() { return ydoc.guid; },
		ydoc,
		tables,
		idb,
		[Symbol.dispose]() { ydoc.destroy(); },
	};
}

export const workspace = openFilesWorkspace();

function fileContentDocGuid(fileId: string) {
	return docGuid({
		workspaceId: workspace.id,
		collection: 'files',
		rowId: fileId,
		field: 'content',
	});
}

// Browser child-document cache: one Y.Doc per file, keyed by file id.
export const fileContentDocs = createDisposableCache((fileId: string) => {
	const ydoc = new Y.Doc({
		guid: fileContentDocGuid(fileId),
		gc: false,
	});
	const content = attachPlainText(ydoc, 'content');
	const idb = attachIndexedDb(ydoc);

	// Bump parent row's updatedAt on local edits only (tx.local invariant).
	onLocalUpdate(ydoc, () => {
		workspace.tables.files.update(fileId, { updatedAt: Date.now() });
	});

	return {
		ydoc,
		content,
		idb,
		[Symbol.dispose]() { ydoc.destroy(); },
	};
});

export async function clearFileContentLocalData() {
	await Promise.all(
		workspace.tables.files.getAllValid().map((file) =>
			clearDocument(fileContentDocGuid(file.id)),
		),
	);
}

async function documentExample() {
	workspace.tables.files.set({
		id: 'file-1',
		name: 'hello.md',
		updatedAt: Date.now(),
		_v: 1,
	});

	// Load a content handle for the row. Dispose when done.
	using handle = fileContentDocs.open('file-1');
	await handle.idb.whenLoaded;

	handle.content.insert(0, '# Hello from a document');
	console.log(handle.content.toString());
}

void documentExample;
```

Opens are refcounted: multiple callers (editor, filesystem actions, materializer) can `.open(fileId)` concurrently and share one Y.Doc. The cache tears the bundle down `gcTime` after the last handle disposes. The default is `5_000` ms.

## Table Operations

All table operations live on direct properties such as `bundle.tables.posts`.

### Write operations

`set(row)` inserts or replaces a whole row.

```typescript
workspace.tables.posts.set({
	id: 'post-1',
	title: 'First post',
	published: false,
	_v: 1,
});

workspace.tables.posts.set({
	id: 'post-1',
	title: 'First post, replaced',
	published: true,
	_v: 1,
});
```

### Update operations

`update(id, partial)` reads the row, merges the partial fields, validates the merged result, and writes it back.

Possible return values:

- `{ status: 'updated', row }`
- `{ status: 'not_found', id, row: undefined }`
- `{ status: 'invalid', id, errors, row }`

```typescript
const updateResult = workspace.tables.posts.update('post-1', {
	published: true,
	views: 1,
});

if (updateResult.status === 'updated') {
	console.log(updateResult.row.views);
}
```

### Read operations

| Method | Return type | Notes |
| --- | --- | --- |
| `get(id)` | `GetResult<TRow>` | Returns `valid`, `invalid`, or `not_found` |
| `getAll()` | `RowResult<TRow>[]` | Includes invalid rows |
| `getAllValid()` | `TRow[]` | Skips invalid rows |
| `getAllInvalid()` | `TableParseError[]` | Debug schema drift or corrupt data |
| `filter(predicate)` | `TRow[]` | Runs only on valid rows |
| `find(predicate)` | `TRow \| undefined` | First valid match |
| `has(id)` | `boolean` | Existence only |
| `count()` | `number` | Counts valid and invalid rows |

```typescript
const one = workspace.tables.posts.get('1');
if (one.status === 'valid') {
	console.log(one.row.title);
}

const all = workspace.tables.posts.getAll();
const valid = workspace.tables.posts.getAllValid();
const published = workspace.tables.posts.filter((row) => row.published);
const firstPublished = workspace.tables.posts.find((row) => row.published);
const hasPostTwo = workspace.tables.posts.has('2');
const count = workspace.tables.posts.count();
```

### Delete operations

| Method | Behavior |
| --- | --- |
| `delete(id)` | Deletes one row; missing IDs are a silent no-op |
| `clear()` | Deletes all rows in the table |

```typescript
workspace.tables.tags.set({ id: 'tag-1', name: 'important', _v: 1 });
workspace.tables.tags.delete('tag-1');
workspace.tables.tags.clear();
```

### Reactive updates

`observe(callback)` reports a set of changed IDs and the optional Yjs transaction origin. Use `table.get(id)` inside the callback to see whether the row now exists.

```typescript
const unsubscribe = workspace.tables.files.observe((changedIds, origin) => {
	for (const id of changedIds) {
		const result = workspace.tables.files.get(id);
		if (result.status === 'not_found') {
			console.log('deleted:', id);
			continue;
		}

		if (result.status === 'valid') {
			console.log('present:', result.row.name);
		}
	}
});

workspace.tables.files.set({ id: 'file-1', name: 'notes.md', _v: 1 });
workspace.tables.files.delete('file-1');
unsubscribe();
```

The `origin` argument is whatever the caller passed to `ydoc.transact(fn, origin)`: or `null` for a direct mutation. Treat it as an opt-in channel for callers that want to tag their own writes:

```typescript
const APP_ORIGIN = Symbol('my-app');

ydoc.transact(() => {
	workspace.tables.posts.set({ id: 'p1', title: 'Tagged', _v: 1 });
}, APP_ORIGIN);

workspace.tables.posts.observe((_ids, origin) => {
	if (origin === APP_ORIGIN) return; // ignore my own echoes
});
```

For the common case of "react only to local edits, not to sync/IDB replays," use `onLocalUpdate(ydoc, fn)`: it filters on Yjs's own `transaction.local` invariant and doesn't depend on origin conventions.

## Attachments

Attachments are the opt-in capabilities you compose inside a builder. Browser-safe attachments ship from the package root. Node and Bun-only attachments use explicit subpaths.

```typescript
import {
	attachBroadcastChannel,
	attachOwnedBroadcastChannel,
	attachIndexedDb,
	attachTables,
	attachYjsSync,
	openCollaboration,
	roomWsUrl,
	websocketUrl,
} from '@epicenter/workspace';
import { attachYjsLog } from '@epicenter/workspace/node';
```

### Persistence

Browser apps use `attachIndexedDb(ydoc)`. Bun/Node daemons use `attachYjsLog(ydoc, { filePath })`. Both bind to the Y.Doc and tear down on `ydoc.destroy()`.

| Primitive | Runtime | Barrier | Other | Purpose |
|---|---|---|---|---|
| `attachIndexedDb(ydoc)` | browser | `whenLoaded`, `whenDisposed` | `clearLocal()` | Local Yjs persistence via `y-indexeddb` |
| `attachYjsLog(ydoc, { filePath })` | Bun/Node | `whenDisposed` (sync replay; no `whenLoaded` needed) | `clearLocal()` | Append-log SQLite file the daemon writes |

Authenticated browser workspaces can call `wipeOwnerLocalYjsData({ userId, ydocGuids })` after disposal to delete owner-scoped local Yjs databases.

`attachSqliteMaterializer` and `attachMarkdownMaterializer` are not persistence: they project workspace rows into queryable SQLite tables or `.md` files. See the materializer subsections below.

```typescript
import * as Y from 'yjs';
import {
	attachTables,
	defineTable,
} from '@epicenter/workspace';
import { attachYjsLog } from '@epicenter/workspace/node';
import { type } from 'arktype';

const notes = defineTable(type({ id: 'string', title: 'string', _v: '1' }));

function openNotes() {
	const ydoc = new Y.Doc({ guid: 'epicenter.notes' });
	const tables = attachTables(ydoc, { notes });
	const yjsLog = attachYjsLog(ydoc, { filePath: '/tmp/epicenter/notes.db' });

	return {
		get id() { return ydoc.guid; },
		ydoc,
		tables,
		yjsLog,
		[Symbol.dispose]() { ydoc.destroy(); },
	};
}

void openNotes;
```

### Sync

Two primitives wrap the WebSocket transport: `openCollaboration` for the workspace document (sync + presence + RPC + peers), and `attachYjsSync` for content documents that only need bytes-on-the-wire. Compose either with `attachBroadcastChannel(ydoc)` for local-only documents, or `attachOwnedBroadcastChannel(ydoc, { userId })` for authenticated browser workspaces.

```typescript
import * as Y from 'yjs';
import {
	attachBroadcastChannel,
	attachIndexedDb,
	attachTables,
	attachYjsSync,
	defineTable,
	websocketUrl,
} from '@epicenter/workspace';
import { type } from 'arktype';

const tabs = defineTable(type({ id: 'string', url: 'string', _v: '1' }));

function openTabs() {
	const ydoc = new Y.Doc({ guid: 'epicenter.tabs' });
	const tables = attachTables(ydoc, { tabs });
	const idb = attachIndexedDb(ydoc);
	attachBroadcastChannel(ydoc);
	const sync = attachYjsSync(ydoc, {
		url: websocketUrl(`https://sync.epicenter.so/rooms/${ydoc.guid}`),
		waitFor: idb.whenLoaded,
	});

	return {
		get id() { return ydoc.guid; },
		ydoc,
		tables,
		idb,
		sync,
		[Symbol.dispose]() { ydoc.destroy(); },
	};
}

void openTabs;
```

Ordering is just lexical: `sync` reads `idb.whenLoaded` as `waitFor` because `idb` is defined first. No builder chain, no priority flag.

### Markdown materializer

The markdown materializer is exported from `@epicenter/workspace/document/materializer/markdown`. Compose it inside your builder alongside the other attachments: it needs `tables` and `ydoc`, both of which are already in lexical scope.

```typescript
import { type } from 'arktype';
import * as Y from 'yjs';
import {
	attachTables,
	defineTable,
} from '@epicenter/workspace';
import { attachYjsLog } from '@epicenter/workspace/node';
import {
	attachMarkdownMaterializer,
	slugFilename,
} from '@epicenter/workspace/document/materializer/markdown';

const notes = defineTable(
	type({ id: 'string', title: 'string', body: 'string', _v: '1' }),
);

function openNotes() {
	const ydoc = new Y.Doc({ guid: 'epicenter.notes' });
	const tables = attachTables(ydoc, { notes });
	const yjsLog = attachYjsLog(ydoc, {
		filePath: '/tmp/epicenter/notes-workspace.db',
	});
	const markdown = attachMarkdownMaterializer(ydoc, {
		dir: '/tmp/epicenter/markdown',
	}).table(tables.notes, { filename: slugFilename('title') });

	return {
		get id() { return ydoc.guid; },
		ydoc,
		tables,
		yjsLog,
		markdown,
		[Symbol.dispose]() { ydoc.destroy(); },
	};
}

void openNotes;
```

### SQLite materializer

The SQLite materializer is exported from `@epicenter/workspace/document/materializer/sqlite`. It mirrors table rows into queryable SQLite tables with optional FTS5 full-text search, using a builder pattern with `.table()` opt-in.

```typescript
import { Database } from 'bun:sqlite';
import * as Y from 'yjs';
import {
	attachTables,
	defineTable,
} from '@epicenter/workspace';
import { attachSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';
import { type } from 'arktype';

const posts = defineTable(
	type({
		id: 'string',
		title: 'string',
		body: 'string',
		published: 'boolean',
		_v: '1',
	}),
);

function openBlog() {
	const ydoc = new Y.Doc({ guid: 'epicenter.blog' });
	const tables = attachTables(ydoc, { posts });
	const db = new Database('/tmp/epicenter/blog.db');
	ydoc.once('destroy', () => db.close());
	const mirror = attachSqliteMaterializer(ydoc, { db }).table(tables.posts, {
		fts: ['title', 'body'],
	});

	return {
		get id() { return ydoc.guid; },
		ydoc,
		tables,
		mirror,
		[Symbol.dispose]() { ydoc.destroy(); },
	};
}

// After mirror.whenFlushed:
// blog.mirror.search('posts', 'hello');
// blog.mirror.count('posts');
// blog.mirror.rebuild('posts');
void openBlog;
```

The `MirrorDatabase` interface is structurally compatible with `bun:sqlite`'s `Database` and `better-sqlite3`'s `Database`: no wrapper needed. Pass your driver directly.

## Workspace Dependencies

Workspaces depend on each other the normal way: regular imports.

There is no special dependency graph inside the workspace package. If one action needs another workspace, import the other workspace bundle or factory and call it directly.

```typescript
import Type from 'typebox';
import { defineMutation } from '@epicenter/workspace';

declare const authWorkspace: {
	actions: {
		users_get_by_id: (input: { id: string }) => { id: string; name: string } | null;
	};
};

declare const blogWorkspace: {
	tables: {
		posts: {
			set: (row: {
				id: string;
				title: string;
				authorId: string;
				_v: 1;
			}) => void;
		};
	};
};

const createPost = defineMutation({
	title: 'Create Post',
	description: 'Create a post for an existing author.',
	input: Type.Object({
		id: Type.String(),
		title: Type.String(),
		authorId: Type.String(),
	}),
	handler: ({ id, title, authorId }) => {
		const author = authWorkspace.actions.users_get_by_id({ id: authorId });
		if (!author) return null;

		blogWorkspace.tables.posts.set({
			id,
			title,
			authorId,
			_v: 1,
		});

		return { id };
	},
});

void createPost;
```

That example uses `declare` stubs so the snippet compiles on its own, but the real pattern is just plain module composition.

## Actions

Actions are the current abstraction for developer-facing operations.

They have four important properties:

1. They are callable functions.
2. They carry metadata (`type`, `title`, `description`, `input`).
3. They close over `tables`, `kv`, and friends by normal JavaScript closure.
4. They are exposed on the bundle returned from your builder (typically as `actions: defineActions({ ... })`, a flat registry keyed by snake_case ASCII strings).

### Query actions

Use `defineQuery(...)` for reads.

```typescript
import { type } from 'arktype';
import Type from 'typebox';
import * as Y from 'yjs';
import {
	attachTables,
	defineActions,
	defineQuery,
	defineTable,
} from '@epicenter/workspace';

const posts = defineTable(
	type({
		id: 'string',
		title: 'string',
		published: 'boolean',
		_v: '1',
	}),
);

function openPosts() {
	const ydoc = new Y.Doc({ guid: 'epicenter.actions.queries' });
	const tables = attachTables(ydoc, { posts });

	const actions = defineActions({
		posts_list: defineQuery({
			title: 'List Posts',
			description: 'List all posts.',
			handler: () => tables.posts.getAllValid(),
		}),
		posts_get_by_id: defineQuery({
			title: 'Get Post',
			description: 'Get one post by ID.',
			input: Type.Object({ id: Type.String() }),
			handler: ({ id }) => tables.posts.get(id),
		}),
	});

	return {
		get id() { return ydoc.guid; },
		ydoc,
		tables,
		actions,
		[Symbol.dispose]() { ydoc.destroy(); },
	};
}

const workspace = openPosts();
const actionType = workspace.actions.posts_list.type;
void actionType;
```

### Mutation actions

Use `defineMutation(...)` for writes or side effects.

```typescript
import { type } from 'arktype';
import Type from 'typebox';
import * as Y from 'yjs';
import {
	attachTables,
	defineActions,
	defineMutation,
	defineTable,
	generateId,
} from '@epicenter/workspace';

const posts = defineTable(
	type({
		id: 'string',
		title: 'string',
		published: 'boolean',
		_v: '1',
	}),
);

function openPosts() {
	const ydoc = new Y.Doc({ guid: 'epicenter.actions.mutations' });
	const tables = attachTables(ydoc, { posts });

	const actions = defineActions({
		posts_create: defineMutation({
			title: 'Create Post',
			description: 'Create a new post row.',
			input: Type.Object({ title: Type.String() }),
			handler: ({ title }) => {
				const id = generateId();
				tables.posts.set({ id, title, published: false, _v: 1 });
				return { id };
			},
		}),
		posts_publish: defineMutation({
			title: 'Publish Post',
			description: 'Mark a post as published.',
			input: Type.Object({ id: Type.String() }),
			handler: ({ id }) => tables.posts.update(id, { published: true }),
		}),
	});

	return {
		get id() { return ydoc.guid; },
		ydoc,
		tables,
		actions,
		[Symbol.dispose]() { ydoc.destroy(); },
	};
}

void openPosts;
```

### Input validation

Action inputs are TypeBox. `defineQuery` and `defineMutation` are typed around `typebox` `TSchema` inputs:

```typescript
import Type from 'typebox';
import { defineQuery } from '@epicenter/workspace';

const searchPosts = defineQuery({
	title: 'Search Posts',
	description: 'Search posts by query string.',
	input: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()) }),
	handler: ({ query, limit }) => ({ query, limit: limit ?? 10 }),
});

void searchPosts;
```

No-input actions are just as valid:

```typescript
import { defineMutation } from '@epicenter/workspace';

const clearCache = defineMutation({
	title: 'Clear Cache',
	description: 'Clear a local cache.',
	handler: () => {
		return { cleared: true };
	},
});

void clearCache;
```

### Action properties

Every action exposes:

- `action.type`: `'query'` or `'mutation'`
- `action.title`: optional UI-facing label
- `action.description`: optional adapter-facing description
- `action.input`: optional TypeBox schema

And the action itself is callable. There is no separate `.handler` property on the returned object.

### Type guards and iteration

```typescript
import Type from 'typebox';
import {
	defineActions,
	defineMutation,
	defineQuery,
	isAction,
} from '@epicenter/workspace';

const actions = defineActions({
	posts_list: defineQuery({ handler: () => [] as string[] }),
	posts_create: defineMutation({
		input: Type.Object({ title: Type.String() }),
		handler: ({ title }) => ({ title }),
	}),
});

for (const [key, action] of Object.entries(actions)) {
	if (isAction(action)) {
		console.log(key, action.type);
	}
}

const listAction = actions.posts_list;
if (listAction.type === 'query') {
	console.log(listAction.type);
}

const createAction = actions.posts_create;
if (createAction.type === 'mutation') {
	console.log(createAction.type);
}
```

## Package entry points

All attachments, schema definitions, and the `createDisposableCache` primitive
live at the package root. The only
subpath exports today are the materializers (which pull in heavier dependencies)
and a few utility surfaces.

| Import path | What it exports | Public today |
| --- | --- | --- |
| `@epicenter/workspace` | `createDisposableCache`, `defineTable`, `defineKv`, browser-safe `attach*` (tables, kv, indexeddb, sync, broadcast-channel, awareness, encryption, rich-text, plain-text, timeline), action helpers, `onLocalUpdate`, `docGuid`, ids, dates, types | Yes |
| `@epicenter/workspace/node` | Bun/Node `attach*` and `open*` (`attachYjsLog`, `attachYjsLogReader`, `openSqliteReader`, `openWriterSqlite`), daemon helpers, workspace paths | Yes |
| `@epicenter/workspace/document/materializer/markdown` | `attachMarkdownMaterializer`, serializers | Yes |
| `@epicenter/workspace/document/materializer/sqlite` | `attachSqliteMaterializer`, `generateDdl`, types | Yes |
| `@epicenter/workspace/ai` | `actionsToAiTools` (TanStack AI bindings) | Yes |

## Architecture & Lifecycle

### Singleton vs factory

Two composition shapes, one builder contract.

**Singleton**: one workspace per app, instantiated at module scope:

```
┌──────────────────────────────────────────────────────────┐
│ function openApp() {                                      │
│   const ydoc = new Y.Doc({ guid: 'epicenter.my-app' });  │
│   const tables        = attachTables(ydoc, { ... });     │
│   const idb           = attachIndexedDb(ydoc);            │
│   const collaboration = openCollaboration(ydoc, {         │
│     waitFor: idb.whenLoaded, replica, actions: { ... },   │
│   });                                                     │
│   return { ydoc, tables, idb, collaboration,              │
│            [Symbol.dispose]() { ydoc.destroy(); } };     │
│ }                                                         │
│ export const workspace = openApp();                       │
└──────────────────────────────────────────────────────────┘
```

**Browser document cache**: many child documents, keyed by id:

```typescript
export const fileContentDocs = createDisposableCache((fileId: string) => {
	const ydoc = new Y.Doc({ guid: fileContentDocGuid(fileId) });
	const content = attachPlainText(ydoc, 'content');
	const idb = attachIndexedDb(ydoc);
	return {
		ydoc,
		content,
		idb,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
});

export async function clearFileContentLocalData() {
	await Promise.all(
		workspace.tables.files.getAllValid().map((file) =>
			clearDocument(fileContentDocGuid(file.id)),
		),
	);
}

using handle = fileContentDocs.open('file-1');
await handle.idb.whenLoaded;
```

The cache builder names how to build one live child document. The app-local
cleanup helper names how to clear local browser storage without constructing
child documents.

### `batch(fn)`

A `batch(fn)` helper groups mutations into a single Yjs transaction. The framework doesn't inject it: include it in your bundle (`batch: (fn) => ydoc.transact(fn)`), which is what every app in this repo does.

```typescript
workspace.batch(() => {
	workspace.tables.posts.set({ id: 'p1', title: 'One transaction', _v: 1 });
	workspace.tables.tags.set({ id: 't1', name: 'docs', _v: 1 });
});
```

Yjs transactions do not roll back on throw. They batch notifications; they are not SQL transactions.

### Readiness, `clearLocal`, and teardown

| API | What it means |
| --- | --- |
| `bundle.idb.whenLoaded` (or `bundle.sqlite.whenLoaded`) | Direct subsystem readiness; the default form |
| `bundle.whenReady` | Optional aggregate: only when the bundle composes 2+ subsystem signals into `Promise.all([...])` |
| `bundle.idb.clearLocal()` (or `bundle.sqlite.clearLocal()`) | Wipes persisted local state for that attachment |
| `bundle[Symbol.dispose]()` | Singleton teardown: your builder calls `ydoc.destroy()` |
| `handle[Symbol.dispose]()` | Cache handle: decrements refcount; last dispose arms `gcTime` |
| `cache[Symbol.dispose]()` | Flushes every cached entry immediately |

Disposal preserves data: it releases the handle. To wipe persisted local state, call `clearLocal()` on the persistence attachment (`bundle.idb` or `bundle.sqlite`) directly.

### Cleanup lifecycle (cache)

```
┌─────────────────────────────────────────────────────────────┐
│ handle[Symbol.dispose]() called (or `using` block exits)   │
│    refcount--                                              │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ refcount === 0: arm gcTime timer                           │
│    • fresh open() during grace window cancels teardown     │
│    • gcTime: 0 tears down immediately                      │
│    • gcTime: Infinity never auto-evicts                    │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ bundle[Symbol.dispose]() fires                             │
│    • your builder's teardown (ydoc.destroy())              │
│    • ydoc.destroy() cascades to every attachment via       │
│      ydoc.on('destroy'): providers close, observers       │
│      stop, sockets shut down                               │
└─────────────────────────────────────────────────────────────┘
```

`cache[Symbol.dispose]()` is synchronous and does **not** wait for async attachment cleanup (IDB `db.close()`, WebSocket onclose) to settle. If a caller needs a real teardown barrier (close-then-reopen in tests, process exit), await a specific attachment-level field:

```ts
cache[Symbol.dispose]();
await handle.idb.whenDisposed;
```

## Client vs Server

`@epicenter/workspace` is the core client/workspace library. The public root export does not currently ship a built-in server helper.

What the package does give you is the raw material a server adapter needs:

- `bundle.collaboration.actions` (the typed `ActionRegistry` from `openCollaboration`)
- `defineActions(actions)` to author a flat snake_case registry
- `toActionMeta(action)` to project an action to its wire-safe metadata
- iterate with `Object.entries(actions)`
- action metadata (`type`, `title`, `input`, `description`)
- direct access to `bundle.tables`, `bundle.kv`, `bundle.collaboration.peers`, and per-row content factories

If you want HTTP, CLI, or MCP on top, build or import an adapter around those primitives.

## API Reference

### Schema definition

```typescript
import { defineKv, defineTable } from '@epicenter/workspace';
```

- `defineTable(schema)`
- `defineTable(v1, v2, ...).migrate(fn)`
- `defineKv(schema, defaultValue)`

### Document creation

```typescript
import { createDisposableCache } from '@epicenter/workspace';
```

`createDisposableCache(build, { gcTime? })` returns a refcounted id cache.
`.open(id)` mints a live handle by shallow-spreading the bundle your builder
returned, so `ydoc`, `content`, `idb`, and any composed `whenReady` are all
things you explicitly put in the bundle.

For singleton apps, call your builder function once at module scope. For Node
one-shot operations, call the child builder directly inside `using`. Use the
cache when browser components, daemons, or materializers have a real
same-process reuse invariant.

### Typical bundle properties

Everything below is a *convention*: the builder is free to expose more or less. Most epicenter apps return at least:

- `id` (as `get id() { return ydoc.guid; }`)
- `ydoc`
- `tables`
- `kv`
- `awareness`
- `idb` (or `sqlite`)
- `sync`
- `encryption` (when encrypted)
- `actions`
- `batch(fn)`
- `whenReady` (only when composed from 2+ subsystem signals; otherwise consumers await `idb.whenLoaded` directly)
- `[Symbol.dispose]()`

### Document content attachments

Per-row content is just another `attach*` call inside a child document builder.
Pick the attachment that matches the content shape:

- `attachPlainText(ydoc, name)`: binds a `Y.Text`. Editor gets `bundle.content` as `Y.Text`.
- `attachRichText(ydoc, name)`: binds a `Y.XmlFragment` for prosemirror / tiptap / yrs-xml editors.
- `attachTimeline(ydoc)`: a polymorphic timeline that can project as text, rich text, or a sheet. Exposes `read() / write(text) / appendText(text) / asText() / asRichText() / asSheet() / currentType / observe(...) / restoreFromSnapshot(binary)`.

The browser document cache stores these by `rowId`, so multiple browser
consumers share one Y.Doc. Use `cache.open(id)` and `handle[Symbol.dispose]()`
to manage lifecycle.

### Local-update filter

`onLocalUpdate(ydoc, fn)` registers an `afterTransaction` listener filtered on Yjs's `transaction.local` invariant: `true` for direct mutations, `false` for updates applied via `Y.applyUpdate` (sync transports, IndexedDB replay, broadcast channel). Empty transactions are skipped. Use this to bump a parent row's `updatedAt` when its content doc is edited locally:

```typescript
onLocalUpdate(ydoc, () => {
	workspace.tables.files.update(fileId, { updatedAt: Date.now() });
});
```

### Actions

```typescript
import {
	defineActions,
	defineMutation,
	defineQuery,
	isAction,
	toActionMeta,
	type Action,
	type ActionRegistry,
} from '@epicenter/workspace';
```

### Table operations

```typescript
import {
	type BaseRow,
	type InferTableRow,
	type Table,
	type TableDefinition,
	TableParseError,
	type Tables,
} from '@epicenter/workspace';
```

Public table methods:

- `parse(id, input)`
- `set(row)`
- `update(id, partial)`
- `get(id)`
- `getAll()`
- `getAllValid()`
- `getAllInvalid()`
- `filter(predicate)`
- `find(predicate)`
- `delete(id)`
- `clear()`
- `observe(callback)`
- `count()`
- `has(id)`

### KV operations

```typescript
import {
	type InferKvValue,
	type Kv,
	type KvChange,
	type KvDefinition,
} from '@epicenter/workspace';
```

Public KV methods:

- `get(key)`
- `set(key, value)`
- `delete(key)`
- `observe(key, callback)`
- `observeAll(callback)`

### Awareness

```typescript
import {
	type AwarenessAttachment,
	type AwarenessSchema,
	type AwarenessState,
	type InferAwarenessValue,
} from '@epicenter/workspace';
```

Public awareness methods:

- `setLocal(state)`
- `peers()`
- `observe(callback)`
- `raw`

### Introspection

```typescript
import {
	isAction,
	toActionMeta,
} from '@epicenter/workspace';
```

`Object.entries(actions)` lets you iterate the flat registry. Combined with each action's `type`, `title`, `description`, and `input` schema, that is enough to build HTTP, CLI, or MCP adapters without coupling the core package to a transport. `toActionMeta(action)` projects a single action to its wire-safe metadata if you need to ship it across a transport.

### IDs and dates

```typescript
import {
	DateTimeString,
	generateGuid,
	generateId,
	type DateIsoString,
	type Guid,
	type Id,
	type TimezoneId,
} from '@epicenter/workspace';
```

### Storage keys

```typescript
import {
	KV_KEY,
	TableKey,
	type KvKey,
} from '@epicenter/workspace';
```

These matter when you are writing low-level tooling against raw Yjs structures.

## MCP Integration

The core package does not export an MCP server. What it does export is the metadata you need to build one:

- actions with `type`, `title`, `description`, and `input`
- `Object.entries(actions)` to iterate the flat registry
- `isAction` type guard; narrow on `action.type === 'query' | 'mutation'` for the variant
- `toActionMeta(action)` to project an action to its wire-safe shape
- `@epicenter/workspace/ai`: `actionsToAiTools(...)` for TanStack AI tool bindings

That is enough to build adapters that expose workspace actions over HTTP, CLI, or MCP without coupling the core package to one transport.

### Setup

```typescript
import Type from 'typebox';
import {
	defineActions,
	defineMutation,
	defineQuery,
} from '@epicenter/workspace';

const actions = defineActions({
	posts_list: defineQuery({
		title: 'List Posts',
		description: 'List all posts.',
		handler: () => [] as Array<{ id: string; title: string }>,
	}),
	posts_create: defineMutation({
		title: 'Create Post',
		description: 'Create a post.',
		input: Type.Object({ title: Type.String() }),
		handler: ({ title }) => ({ id: title.toLowerCase() }),
	}),
});

for (const [key, action] of Object.entries(actions)) {
	console.log({
		name: key,
		type: action.type,
		title: action.title,
		description: action.description,
		hasInput: action.input !== undefined,
	});
}
```

That is the public adapter surface today.

## Contributing

### Local development

From the repo root:

```bash
bun install
```

Type-check the workspace package itself:

```bash
bun run typecheck
```

### Running tests

From the repo root:

```bash
bun test packages/workspace
```

## Related Packages

If your app's data model is inherently files and folders: a code editor, a note vault with nested directories, anything where users expect `mkdir` and path resolution: [`@epicenter/filesystem`](../filesystem) builds that abstraction on top of this package. It imports `defineTable` to create a `filesTable`, wraps workspace tables and documents into POSIX-style operations (`writeFile`, `mv`, `rm`, `stat`), and plugs into the same extension system.

Most apps won't need it. If you know the shape of every record upfront, workspace tables are the right default. See [Your Data Is Probably a Table, Not a File](../../docs/articles/your-data-is-probably-a-table-not-a-file.md) for the full decision matrix.

## License

MIT
