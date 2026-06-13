# Workspace Actions, Layout, And Attachments

Detailed guidance for inline action registries, action return surfaces, JSDoc, workspace file layout, attachment ordering, and `connectWorkspace`.

## Actions

Actions wrap table operations as `defineMutation` (writes) or `defineQuery` (reads). Define them inline on the returned workspace object when they only need the workspace bundle. Extract a factory only when it is shared by multiple builders or owns an invariant that would be harder to see inline.

```typescript
import {
	createWorkspace,
	defineActions,
	defineMutation,
	defineWorkspace,
} from '@epicenter/workspace';
import { Type } from 'typebox';

export function createBlogWorkspace() {
	const workspace = createWorkspace({
		id: 'epicenter.blog',
		tables: blogTables,
		kv: {},
	});
	const { tables, ydoc } = workspace;
	const batch = (fn: () => void) => ydoc.transact(fn);

	return defineWorkspace({
		...workspace,
		actions: defineActions({
			/**
			 * Mark a post as published and record the publication timestamp.
			 *
			 * Separated from a raw `tables.posts.update()` call because publish
			 * involves setting multiple fields atomically and may trigger side
			 * effects (notifications, RSS rebuild) in future versions.
			 */
			posts_publish: defineMutation({
				description: 'Publish a draft post',
				input: Type.Object({ id: tables.posts.schema.properties.id }),
				handler: ({ id }) => {
					batch(() => {
						tables.posts.update(id, {
							published: true,
							publishedAt: Date.now(),
						});
					});
				},
			}),
		}),
		[Symbol.dispose]() {
			workspace[Symbol.dispose]();
		},
	});
}
```

For full input composition guidance (full-row writes, narrow patches, blanket PATCH, id-only inputs), see [Deriving action input schemas](deriving-action-inputs.md).

### Return shapes: local vs. remote contract

Actions have **two** type surfaces depending on how they're invoked. **Local**
callers see the handler's signature verbatim: sync stays sync, raw stays raw,
throws throw. **Remote** callers (via `collaboration.dispatch()`)
always get `Promise<Result<T, DispatchError>>`: the transport wraps raw values
in `Ok` and converts thrown errors or returned `Err`s into
`Err(DispatchError.ActionFailed)`.

**Rule of thumb:**

- **Return `Err(TypedError)`** for failures local callers should branch on.
- **Throw** for bugs / invariants. On the wire, throws become `ActionFailed`.
  The caller loses the stack and can only say "something broke."
- **Return raw** when failure isn't a meaningful concept for the operation.

Remote peer calls currently expose `DispatchError`, not each handler's typed
error union. If a remote caller needs a narrower failure contract, add an
explicit action surface for that workflow.

For the full matrix (every caller's view of every handler shape, all the
decision trees, and the normalization boundaries), read
[Action return shapes](action-return-shapes.md).

### JSDoc on Action Methods

Every action method inside the `actions` object returned from the workspace builder should have a JSDoc comment. The JSDoc and the `description` field serve **different audiences**:

- **`description`**: consumed by MCP servers, CLI help text, and OpenAPI specs. Keep it short and declarative ("Import skills from disk").
- **JSDoc**: consumed by developers hovering in an IDE. Explain *why* the action exists as a separate operation, what non-obvious behavior it has, or what assumptions it makes.

```typescript
// Bad: Parrots the description
/** Import skills from an agentskills.io-compliant directory. */
importFromDisk: defineMutation({ description: 'Import skills from an agentskills.io-compliant directory', ... })

// Good: Adds distinct value
/**
 * Scan a directory of SKILL.md files and upsert them into the workspace.
 *
 * Skills without a `metadata.id` in their frontmatter get one generated
 * and written back to the file, so future imports produce stable IDs
 * across machines.
 */
importFromDisk: defineMutation({ description: 'Import skills from an agentskills.io-compliant directory', ... })
```

## Workspace File Structure

Default to one shared workspace file plus runtime-specific openers. Split files only when the schema, runtime opener, or action registry has grown enough to earn a boundary.

```
src/lib/
|
|-- workspace.ts                        <- Isomorphic schema, branded IDs, createXWorkspace(), inline pure actions
|-- browser.ts                          <- Browser attachments around createXWorkspace()
|-- daemon.ts                           <- Daemon attachments around createXWorkspace()
|
+-- client.ts                           <- Optional runtime singleton
```

```
workspace.ts
  createWorkspace({ id, tables, kv, keyring? })
    -> defineWorkspace({ ...workspace, actions: defineActions({ ... }) })

browser.ts / daemon.ts / script.ts
  createXWorkspace()
    -> attach persistence, sync, materializers, and runtime actions inline
```

### Layering Rules

1. **`workspace.ts` or `workspace/index.ts`**: Pure schema, branded IDs, `createXWorkspace(...)`, inline pure actions, and child-doc identity. Isomorphic.
2. **`browser.ts`, `daemon.ts`, `script.ts`**: Runtime builders. Call `createXWorkspace(...)`, then compose persistence, sync, materializers, and runtime-specific actions inline.
3. **`client.ts`**: Optional singleton. It owns side effects such as auth subscriptions, persisted UI state, and module-level construction.

### Import Convention

```typescript
// Components/state that need the live workspace instance:
import { workspace, auth } from '$lib/client';

// Components that only need types or the definition:
import { type Note, type NoteId, generateNoteId } from '$lib/workspace';

// Other packages in the monorepo:
import { createHoneycrispWorkspace, type HoneycrispActions } from '@epicenter/honeycrisp';
```

### Package.json Subpath Exports

Each app exports its shared workspace surface from the package root or a single `./workspace` subpath:

```json
{
  "exports": {
    "./workspace": "./src/lib/workspace/index.ts"
  }
}
```

The exported workspace surface is isomorphic, so it is safe for any consumer (server, CLI, other apps). Avoid separate `./definition` and `./actions` subpaths unless a real external consumer needs that split.

### Isomorphic vs Runtime-Specific Actions

Isomorphic actions (table reads/writes, portable logic) belong inline in the workspace builder. Runtime-specific actions, whether browser APIs, Chrome extension APIs, Node/Bun filesystem calls, or Tauri commands, live in the runtime builder where the relevant attachments and APIs are in scope.

```typescript
// workspace.ts: isomorphic workspace factory
export function createMyAppWorkspace() {
  const workspace = createWorkspace({
    id: 'epicenter.myapp',
    tables: myAppTables,
    kv: myAppKv,
  });
  const { tables } = workspace;

  return defineWorkspace({
    ...workspace,
    actions: defineActions({
      devices_list: defineQuery({
        title: 'List Devices',
        description: 'List all synced devices.',
        handler: () => ({ devices: tables.devices.scan().rows }),
      }),
    }),
    [Symbol.dispose]() {
      workspace[Symbol.dispose]();
    },
  });
}

// src/lib/client.ts: browser-specific attachments + runtime actions
export const workspace = createMyAppWorkspace();

const idb = attachIndexedDb(workspace.ydoc);

const actions = defineActions({
  ...workspace.actions,
  tabs_close: defineMutation({
    title: 'Close Tabs',
    description: 'Close browser tabs by ID.',
    input: Type.Object({ tabIds: Type.Array(Type.Number()) }),
    handler: async ({ tabIds }) => {
      await browser.tabs.remove(tabIds);  // Chrome API
      return { closedCount: tabIds.length };
    },
  }),
});

const collaboration = openCollaboration(workspace.ydoc, {
  url,
  waitFor: idb.whenLoaded,
  openWebSocket,
  replicaId,
  actions,
});
```

## Attachment Ordering

Attachments compose through plain lexical scope, so ordering is explicit: if `openCollaboration` needs to wait for local state, its `waitFor` option reads `idb.whenLoaded`, and `idb` must be defined first.

| Attachment | Typical `waitFor` | Behavior |
|---|---|---|
| `createWorkspace({ keyring? })` | (none, sync) | Allocates the workspace `Y.Doc`, wires tables + KV, reads `keyring()` synchronously when encryption is requested |
| `attachYjsLog` | none | Starts loading the Yjs update log immediately |
| `attachIndexedDb` | none | Starts loading IndexedDB immediately |
| `openCollaboration` | `idb.whenLoaded` (or another local-load promise) | Opens WebSocket after local replay |

The standard shape is **persistence first, then collaboration with `waitFor`**:

```
attachIndexedDb  -------------> idb.whenLoaded resolves
                                       ->
openCollaboration({ waitFor: idb.whenLoaded }) -----> WebSocket opens -> synced
```

This ordering matters because sync only exchanges the delta between local state and the server. Without persistence loading first, every cold start downloads the full document.

```typescript
// Correct: persistence loads first, collaboration waits for idb, exchanges delta only
const workspace = createMyAppWorkspace();
const idb = attachIndexedDb(workspace.ydoc);
const collaboration = openCollaboration(workspace.ydoc, {
  url: roomWsUrl(serverUrl, workspace.ydoc.guid),
  waitFor: idb.whenLoaded,
  openWebSocket,
  replicaId,
});

// Wrong: collaboration starts before local state is loaded, downloads full document
const workspace = createMyAppWorkspace();
const collaboration = openCollaboration(workspace.ydoc, { url, openWebSocket, replicaId });
const idb = attachIndexedDb(workspace.ydoc);
```

### `connectWorkspace` (CLI/Script Shortcut)

For server-side Bun scripts, `connectWorkspace` from `@epicenter/cli` handles the unlock to sync chain automatically. It is **ephemeral by design: no local persistence**, so a script can coexist with a long-running `epicenter start` daemon without fighting over the same SQLite file:

```typescript
import { connectWorkspace } from '@epicenter/cli';
import { createFujiWorkspace } from '@epicenter/fuji/workspace';

const workspace = await connectWorkspace(createFujiWorkspace);
// Ready. Authenticated. Syncing. Full doc downloaded from server.

const entries = workspace.tables.entries.scan().rows;
await workspace.dispose();
```

Writes propagate through sync to the daemon, which owns the materializer (markdown, SQLite mirror, etc.).

Use `connectWorkspace` for one-off scripts and agent-written automation. Use `epicenter.config.ts` to register long-running daemon modules and materializers that need persistence and custom workspace-specific extensions. A per-route `daemon.ts` file is a conventional module layout, not a discovery rule.
