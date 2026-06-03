# Pull Request Guidelines

## When to Read This

Read when writing or reviewing PR descriptions, especially for API changes, structural refactors, and visual communication.

## Pull Request Guidelines

### Narrative Over Structure

A PR description is not a changelog. The reader already has the Commits tab and the Files Changed tab—they can see exactly what code moved where. Your job is to provide what those tabs can't: motivation, context, and design decisions.

Open with WHY. What problem existed? What was painful? What forced this change? Then weave WHAT you did into the narrative naturally. The reader should feel like they're being told a story by a colleague, not reading a ticket.

**Good PR opening** (motivation first, then what):

> Honeycrisp and opensidian both need auth—sign-in, sign-up, sign-out, session management, encryption key handling—and the logic is identical between them. Rather than duplicating it, this extracts a shared `createAuthState` factory into `@epicenter/svelte/auth-state` that both apps consume with app-specific callbacks.

**Good PR opening** (terse variant for API redesigns):

> Analysis of 321 error call sites revealed every error is always all-or-nothing on message ownership—the old `.withContext()`/`.withCause()` nesting added flexibility nobody used. This redesigns the `createTaggedError` builder with a flat `.withFields()` API where `.withMessage()` is optional and seals the message.

Both weave motivation into the change description. The reader understands WHY before the details land.

**Bad opening** (only why, no grounding):

> Users were getting logged out mid-upload on large files. The session refresh only triggered on navigation, not during background activity like uploads.

This tells you the problem but not what the PR actually does. The reader has to guess.

**Bad opening** (only what, no motivation):

> This PR adds a keepalive call to the upload handler and updates the session refresh logic.

This tells you what changed but not why anyone should care. The reader has to dig through code to understand the purpose.

**Bad opening** (changelog disguised as prose):

> ## Summary
> - Added shared auth factory to `@epicenter/svelte/auth-state`
> - Fixed workspace type bug where `TEncryption` was phantom
> - Removed runtime type checks

A bulleted list the reader could reconstruct from `git log --oneline`. Tells you nothing about motivation.

### Code Examples Are Mandatory for API Changes

If the PR introduces or modifies APIs, you MUST include code examples showing how to use them. No exceptions.

**What requires code examples:**

- New functions, types, or exports
- Changes to function signatures
- New CLI commands or flags
- New HTTP endpoints
- Configuration changes

**Good API PR** (shows the actual usage):

```typescript
// Define actions once
const actions = {
	posts: {
		create: defineMutation({
			input: type({ title: 'string' }),
			handler: ({ title }) => client.tables.posts.create({ title }),
		}),
	},
};

// Pass to adapters - they generate CLI commands and HTTP routes
const cli = createCLI(client, { actions });
const server = createServer(client, { actions });
```

**Bad API PR** (only describes without showing):

> This PR adds an action system that generates CLI commands and HTTP routes from action definitions.

The first version lets reviewers understand the API at a glance. The second forces them to dig through the code to understand the call sites.

### Before/After Code Snippets for Refactors

Code examples aren't just for API changes. For internal refactors that change how code is structured without changing the public API, before/after code snippets show reviewers the improvement concretely:

```typescript
// BEFORE: direct YKeyValueLww usage with manual scanning
const ykv = new YKeyValueLww<unknown>(yarray);

function reconstructRow(rowId) {           // O(n) - scan every cell
  for (const [key, entry] of ykv.map) {
    if (key.startsWith(prefix)) { ... }
  }
}

// AFTER: composed storage layers
const cellStore = createCellStore<unknown>(ydoc, TableKey(tableId));
const rowStore = createRowStore(cellStore);

rowStore.has(id)           // O(1)
rowStore.get(id)           // O(m) where m = fields per row
rowStore.count()           // O(1)
```

Use before/after snippets when:

- Internal implementation changes significantly even though external API is unchanged
- Performance characteristics change and the code shows why
- Complexity is being moved/decomposed (show what was inlined vs what's now delegated)

### Visual Communication with ASCII Art

Use ASCII diagrams liberally to communicate complex ideas. They're more scannable than prose and show relationships at a glance.

Default to the lightest diagram that carries the relationship: two annotated columns, an indented tree, or a small before/after block. Reserve full box-drawing for genuine multi-box architecture. A heavy box around what is really a two-column mapping costs the reader more than it gives.

#### Journey/Evolution Diagrams

For PRs that iterate on previous work, show the evolution:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  PR #1217 (Jan 7)                                                       │
│  "Add YKeyValue for 1935x storage improvement"                          │
│                                                                         │
│       Y.Map (524,985 bytes) ──→ YKeyValue (271 bytes)                   │
│                                                                         │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  PR #1226 (Jan 8)                                                       │
│  "Remove YKeyValue, use native Y.Map + epoch compaction"                │
│                                                                         │
│  Reasoning: "Unpredictable LWW behavior"  ← ⚠️ (misleading!)            │
│                                                                         │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  This PR                                                                │
│  "Restore YKeyValue with LWW timestamps"                                │
│                                                                         │
│  Why: Timestamp-based resolution gives intuitive "latest wins"          │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

#### Layered Architecture Diagrams

Show how components stack:

```
┌─────────────────────────────────────────────────────────────┐
│  createDisposableCache((id) => { ... }).open(id)            │  ← High-level
│    Refcounted handle factory over per-id workspace bundles  │
├─────────────────────────────────────────────────────────────┤
│  createWorkspace({ id, tables, kv })                        │  ← Mid-level
│    Allocates Y.Doc and constructs typed tables/KV in one    │
├─────────────────────────────────────────────────────────────┤
│  defineTable() / defineKv()                                 │  ← Low-level
│    Pure schema definitions                                  │
└─────────────────────────────────────────────────────────────┘
```

#### Comparison Tables

For showing trade-offs between approaches:

```
┌────────────────────────────────────────────────────────────────┐
│  Use Case                         │  Recommendation            │
├───────────────────────────────────┼────────────────────────────┤
│  Real-time collab, simple cases   │  YKeyValue (positional)    │
│  Offline-first, multi-device      │  YKeyValueLww (timestamp)  │
│  Clock sync unreliable            │  YKeyValue (no clock dep)  │
└────────────────────────────────────────────────────────────────┘
```

#### Flow Diagrams

For showing data/control flow:

```
┌────────────────────────────────────────────────────────────────┐
│                     Conflict Resolution                        │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  Client A (2:00pm)  ──┐                                        │
│                       │──→  Sync  ──→  Winner?                 │
│  Client B (3:00pm)  ──┘                                        │
│                                    │                           │
│                   ┌────────────────┴────────────────┐          │
│                   ▼                                 ▼          │
│             YKeyValue                         YKeyValueLww     │
│          (clientID wins)                   (timestamp wins)    │
│           ~50% correct                       100% correct      │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

#### Composition Tree Diagrams

For refactors that change how modules compose, use lightweight indented tree notation instead of heavy box-drawing. This shows the dependency/composition hierarchy at a glance:

**Before** — one module doing everything:

```
TableHelper (schema + CRUD + row reconstruction + observers)
  └── YKeyValueLww  ←  Map<"rowId:colId", entry>
        ├── reconstructRow()   O(n) scan all keys for prefix
        ├── collectRows()      O(n) group all cells by rowId
        └── deleteRowCells()   O(n) filter + delete
```

**After** — each layer has a single responsibility:

```
TableHelper (schema validation, typed CRUD, branded Id types)
  └── RowStore (in-memory row index → O(1) has/count, O(m) get/delete)
      └── CellStore (cell semantics: key parsing, typed change events)
          └── YKeyValueLww (generic LWW conflict resolution primitive)
```

Key properties of composition trees:

- Use `└──` for single children, `├──` when siblings exist
- Annotate each node with its responsibility in parentheses
- Show performance characteristics when the refactor changes them
- Before/after pair makes the improvement immediately visible

#### File Relocation Trees

When a refactor physically moves files and that relocation IS the architectural statement, show the move pattern as a tree. This is not "listing files changed" (which the skill forbids) — it's showing the structural reorganization:

```
packages/epicenter/src/
├── shared/
│   ├── y-cell-store.ts      →  dynamic/tables/y-cell-store.ts
│   └── y-row-store.ts       →  dynamic/tables/y-row-store.ts
└── dynamic/tables/
    └── table-helper.ts         (refactored to compose over the above)
```

Use file relocation trees when:

- Files moved between directories as part of a module boundary change
- The new location communicates architectural intent (e.g., "these belong to the tables subsystem, not shared")
- There are 2-6 files moved; more than that, describe the pattern instead

Do NOT use when:

- Files were renamed but stayed in the same directory
- The move is incidental to the real change

ASCII art characters to use: `┌ ┐ └ ┘ ─ │ ├ ┤ ┬ ┴ ┼ ▼ ▲ ◀ ▶ ──→ ←── ⚠️ ✅ ❌`

#### Interleaving Prose and Visuals

Never let prose run for more than a short paragraph without a visual break. The rhythm should be: context → visual → explanation → visual → ...

Each visual (code snippet, ASCII diagram, before/after block) should be preceded by 1-3 sentences of context and optionally followed by a sentence explaining the subtle detail. If you're writing more than 4-5 sentences of prose in a row, you're missing an opportunity for a diagram or code block.

#### Reviewer-Oriented Bodies for Stacked PRs

When rewriting descriptions for a stack that has already been split, write for the developer who is deciding where to spend attention. They care about the contract, the shape change, and the shortest honest review path. They do not need a second changelog, a test transcript, or a list of files GitHub already shows.

Use this as a pressure test:

- What contract stayed stable or changed?
- What one call site teaches the new shape?
- What ownership boundary should the reviewer understand before reading files?
- Is there a best file order for reviewing the diff?

For a cleanup PR where the public surface stays stable, make that stability explicit before discussing internals:

```ts
// Still the public shape:
const thing = createThing(options);

await thing.start();
await thing.refresh();
await thing.stop();
```

Then use a tiny tree to show what moved:

```txt
Before:
  createThing
    -> helperA
    -> helperB
    -> internal type visible outside the module

After:
  createThing
    -> owns helper mechanics locally
    -> exposes only the public contract
```

For a tracer or architecture PR, show the shape before prose gets abstract:

```txt
feature-root/
  shared.ts   shared model, schema, actions
  client.ts   browser or UI runtime
  server.ts   server, daemon, or persistence runtime
```

Then show how two runtimes compose the same shared root:

```ts
const clientFeature = openFeature(owner.shared);
attachClientRuntime(clientFeature);

const serverFeature = openFeature(server.shared);
attachServerRuntime(serverFeature);
```

For a loader, convention, or framework change, make the new rule small enough to remember:

```txt
<root>/<name>/<entrypoint>.ts
```

Then show the clearest user-written module that proves the contract:

```ts
export default defineFeature({
	async open(ctx) {
		const feature = openFeature(ctx.shared);
		return attachRuntime(feature, ctx);
	},
});
```

The review path is not a "Changes" section. It is a map for the human reviewer:

```md
Good review path:

1. Start with the contract or discovery file.
2. Read the runtime adapter that consumes it.
3. Skim one migrated caller as proof the shape works.
```

Only include that path when the order genuinely helps. For a two-file fix, prose plus one code snippet is enough.

#### Framing Patterns That Work

These patterns consistently produce strong PR descriptions. They're not formulas—they're thinking tools for finding the angle.

##### Disproportionate Complexity Framing

State the simplest possible description of what the old system accomplished, then contrast it with the machinery it required. The reader should think "that's absurd" before you show the fix.

**Good**: "The old encryption system had five moving parts to answer one question: does this workspace have encryption keys?"

**Good**: "All of that complexity existed to track a single boolean."

**Bad**: "The encryption system was complex and needed simplification." (no contrast, no specifics)

The fix then lands with zero effort—the reader is already rooting for it.

##### Name the One Regression

If a change trades something away, name it and quantify it with the payoff attached, before the reviewer finds it in the diff and reads it as an oversight. A scoped, quantified regression reads as judgment; an unmentioned one reads as a miss.

##### Lead with What Dies (API-collapse PRs)

For PRs that delete or fundamentally reshape an established API surface — especially when the change ripples across many call sites or packages — flip the usual "open with WHY" into a stronger variant: **open with what dies, named explicitly, and let the deletion verb do the work.** The reader anchors on what's gone before what arrives, which makes the rest of the description make sense.

Use this only for PRs where the deletion IS the news. Bug fixes, additive features, and refactors that don't change call sites should use the standard motivation-first opener instead. Counting callers is the quick test — if the change is invisible to call sites, this isn't the right framing.

Four moves that compose:

**1. Open with the deletion verb, naming the dying API.**

> This branch deletes `defineWorkspace` and the `withExtension` chain that drove every workspace in the codebase for a year. The terminal API is **`attach*` primitives composed inline against a Y.Doc the caller owns** — no builder, no extension slots, no framework-imposed bundle shape.

Not "this PR introduces a new composition primitive." Not "we restructured how workspaces are built." *Deletes*, named, with the timespan that makes the stakes clear.

**2. Show concrete before/after at the headline.**

The before/after code block goes in the first hundred words, not after pages of context. A reader who only reads the opening already knows the shape change. This is stronger than the standard "code examples mandatory for API changes" rule — for API-collapse PRs, the before/after IS the headline.

**3. Diagnose the old API without abstract complaints.**

> The chain wasn't doing real work. Each `.withExtension(name, factory)` call was a typed closure with extra ceremony to make the extension's exports reachable through the framework's generic shape. Once you have a Y.Doc as a local variable, `attachIndexedDb(ydoc)` is shorter and exposes its own typed handle (`idb.whenLoaded`, `idb.clearLocal`) without traveling through a slot.

Specific. Falsifiable. A reader who disagrees can point to which sentence is wrong. Not "the chain was unmaintainable" or "the API didn't scale."

**4. Name every type that died as an explicit inventory; name the survivor with the reason it earned its keep.**

> `Document` (a structural contract for "what a workspace returns"), `DocumentBundle`, `DocumentHandle` (a refcounted brand around bundles), `DocumentFactory`, `createDocumentFactory`, `defineDocument`, `defineWorkspace`, `ActionIndex` (a flat map of branded actions walked from arbitrary bundles), `iterateActions`, `ACTION_BRAND` (the symbol that made the walk possible), `entry.handle` envelope in the CLI loader: all gone. What's left is the terminal primitive set that can build everything those layers were built to do, plus one piece of factory-shaped infrastructure (`createDisposableCache`) that survived because it does work the caller can't trivially do inline: refcount + grace-period teardown for any `Disposable`.

Not "and other types" — the actual list, parenthetically annotated. Two reasons: (a) it lets the reader grep, (b) it forces the author to verify the inventory is exhaustive. The survivor gets a *justification* in the same sentence — not "we kept the cache" but "survived because it does work the caller can't trivially do inline." Without that justification, the reader assumes the survivor is leftover scaffolding and tries to delete it later.

**Cascade structure when the deletion ripples through layers.**

If the deletion forces structural changes to surrounding code (package surface, app shape, consumer wiring), make the cascade explicit. Each layer's collapse caused the next. The PR-A body's opener uses this:

```
API change       → defineWorkspace dies; attach* primitives become the surface
       │
       ▼
Package surface  → @epicenter/document gets merged into @epicenter/workspace
       │            (one published surface, one barrel)
       ▼
App shape        → apps split into iso/env/client three files because the iso
                    layer being importable from Node was the whole point
       │
       ▼
Metadata         → 520 commits, 19 packages — held until AFTER the story
```

Hold metadata (commit count, scope, file count) until after the story. Numbers don't tell the reader anything until they understand what the numbers count.

**Bad version of this pattern** (just listing deletions without the diagnosis or survivor justification):

> This PR deletes `Document`, `DocumentBundle`, `DocumentHandle`, `createDocumentFactory`, `defineDocument`, `defineWorkspace`, `ActionIndex`, `iterateActions`, `ACTION_BRAND`. We replaced them with inline `attach*` calls. Net: 520 commits, 534 files.

The list is there, but the reader has no idea why any of those types existed in the first place, why they were wrong, or what survived. It reads as destruction without architecture. The good version makes the reader understand the *necessity* of each deletion before the inventory lands.

##### Bold Topic Sentences for Long PRs

For PRs with multiple distinct concerns, use `---` separators and bold opening sentences as scannable anchors. These are NOT section headers—they're topic sentences that let someone skim the PR and understand its shape.

```markdown
---

**First, a small correction: SYNC_STATUS was documented as a heartbeat but it isn't one.**

Liveness is already handled by text-level ping/pong. What SYNC_STATUS actually
needs to do is track whether the client has local changes...

---

**The Durable Object message handler needed a cleaner return shape before RPC could be added.**

The old handler returned an optional-fields bag...
```

Use this when a PR has 3+ distinct concerns that each need their own context. For simpler PRs, just write paragraphs.

##### "Came Along for the Ride" Transitions

When a PR includes secondary improvements that aren't the main point, subordinate them explicitly:

**Good**: "Two follow-up improvements came along for the ride. First, fingerprint dedup..."

**Good**: "While getting there required fixing a few things that were already slightly wrong..."

This signals to the reader: "the main narrative is done, here are bonuses." Without this transition, the reader doesn't know if they're still in the main argument or reading about side effects.

##### Sequential Journey for Multi-Part PRs

When a PR builds on itself in stages (protocol + routing + client + typed contracts + structural collapse), tell the story in the order it happened. The reader follows the same journey you did:

1. State the end goal ("peer-to-peer RPC over the sync layer")
2. Walk through each prerequisite in the order you hit it
3. Each step motivates the next: "the handler needed a cleaner shape *before* RPC could be added"

This only works for PRs where the order matters. For PRs with independent concerns, bold topic sentences work better.

##### Casual Closing Stats

End with a one-liner about scope. Not a metrics table, not a section—just a fact:

**Good**: "Net change across 26 files: about 1700 lines deleted, 900 net lines removed."

**Good**: "23 commits on top of the encryption branch. 61 files changed. Stacks on #1591—merge that first."

This grounds the reader in scope after they've absorbed the narrative. It's the last thing they see before deciding to review.
### Other Guidelines

- NEVER include Claude Code or opencode watermarks or attribution in PR titles/descriptions
- PR title should follow same conventional commit format as commits
- Focus on the "why" and "what" of changes, not the "how it was created"
- Include any breaking changes prominently
- Link to relevant issues

### Pull Request Body Format

#### Default: Continuous Prose

Every PR, simple or complex, uses continuous prose as the default format. Write paragraphs that flow naturally, interleaved with code snippets and diagrams where they add clarity. No section headers, no numbered steps, no bullet-point changelogs.

The rhythm is: context paragraph -> code/diagram -> explanation paragraph -> code/diagram -> ...

For a focused correction, two paragraphs suffice. For a large feature, you'll write more paragraphs with more visuals, but the FORMAT stays the same. The difference is length, not structure.

**Example (simple fix)**:

````
Drawers with long content overflow without scrolling, which makes it impossible to reach content below the fold on mobile.

Wrapping `{@render children?.()}` in a `<div class="flex-1 overflow-y-auto">` container fixes this. `flex-1` takes remaining space after the drag handle; `overflow-y-auto` enables scrolling when needed.
````

**Example (multi-concern feature)**:

````
Honeycrisp and opensidian both need auth—sign-in, sign-up, sign-out, session
management, encryption key handling—and the logic is identical between them.
Rather than duplicating it, this extracts a shared `createAuthState` factory
into `@epicenter/svelte/auth-state` that both apps consume with app-specific
callbacks.

The factory handles the Better Auth client, token management via a `TokenStore`
abstraction, and a phase state machine. Each app wires its own workspace side
effects through `onSignedIn`/`onSignedOut` callbacks:

```typescript
export const authState = createAuthState({
    baseURL: API_URL,
    storagePrefix: 'honeycrisp',
    tokenStore,
    async onSignedIn(encryptionKey) {
        await workspace.activateEncryption(base64ToBytes(encryptionKey));
        workspace.extensions.sync.reconnect();
    },
});
```

A separate `TokenStore` lives in its own file so that the workspace sync
extension can read the token without importing auth—breaking what would
otherwise be a circular dependency.

```
token-store.ts           (standalone)
    ▲          ▲
    │          │
auth/index.ts  workspace/client.ts
```

This PR also fixes a workspace type bug where `TEncryption` was tracked as
a phantom generic parameter but never intersected into the builder type...
````

Notice: no `## Summary`, no bullet lists, no section headers. Just paragraphs that explain the motivation and weave in code/diagrams where they help.

#### When to Use Section Headers

Almost never. The two exceptions:

- **`### Why X?` headings** for genuinely distinct design decisions that need their own justification. Write as direct statements, not hedged observations. Example: `### Why a flat API instead of nested builders?`. Keep it rare—one or two per large PR, not one per change.
- **Future work / deferred items** at the end of a long PR, when there are concrete follow-ups worth calling out. A short paragraph or a few lines is fine—this is the one place a brief list is acceptable.

#### Code Examples and Diagrams

Code examples are mandatory for any PR that introduces or modifies APIs. Diagrams are strongly encouraged for any PR that changes how modules compose. Both are interspersed into the prose—not collected under their own section header.

#### Voice and Tone

- **Conversational but precise**: Write like explaining to a colleague
- **Direct and honest**: "This has been painful" rather than "This presented challenges"
- **Show your thinking**: "We considered X, but Y made more sense because..."
- **Use "we" for team decisions, "I" for personal observations**

#### Example PR Description:

````
This fixes the long-standing issue with nested reactivity in state management.

First, some context: users have consistently found it cumbersome to create deeply reactive state. The current approach requires manual get/set properties, which doesn't feel sufficiently Svelte-like. Meanwhile, we want to move away from object mutation for future performance optimizations, but `obj = { ...obj, x: obj.x + 1 }` is ugly and creates overhead.

This PR introduces proxy-based reactivity that lets you write idiomatic JavaScript:

```javascript
let todos = $state([]);
todos.push({ done: false, text: 'Learn Svelte' }); // just works
```

Under the hood, we're using Proxies to lazily create signals as necessary. This gives us the ergonomics of mutation with the performance benefits of immutability.

Still TODO:
- Performance optimizations for large arrays
- Documentation updates
- Migration guide for existing codebases

This doubles down on Svelte's philosophy of writing less, more intuitive code while setting us up for the fine-grained reactivity improvements planned for v6.
````

#### What to Avoid (HARD RULES)

These are the most common failure modes. If you catch yourself doing any of these, stop and rewrite.

- **ANY section header at the top**: No `## Summary`, `## Changes`, `## Overview`, `## What Changed`. The description IS the summary—just start writing prose.
- **Bullet-point changelogs**: A bulleted list of what changed is redundant with the Commits tab. The reader needs motivation and context, not a list they can already see.
- **Listing files changed**: GitHub's Files Changed tab exists. Never enumerate file paths.
- **Opening with WHAT instead of WHY**: "This PR adds X, Y, Z" is a changelog. "X and Y both need Z, and the logic is identical" is a narrative.
- **Structured formats for simple PRs**: Numbered steps, labeled sections, and templated formats signal that you're filling out a form instead of thinking about your reader.
- Marketing language, corporate speak, clichés, or dramatic hyperbole
- Test plans (unless specifically requested)
- Over-explaining simple changes
- Apologetic tone for reasonable decisions

#### Real Examples (Gold Standard)

These are actual PR descriptions from this repo that demonstrate every pattern above working together. Study them—they're the bar.

##### Example: Refactor PR (disproportionate complexity + before/after + composition tree + casual close)

````
The old encryption system had five moving parts to answer one question: does this workspace have encryption keys? You had to call `.withEncryption()` on the builder chain, then call `encryption.unlock(keys)` asynchronously, and the encrypted Y.Map wrapper maintained a dual-cache of both encrypted and decrypted values simultaneously. On top of that, an IndexedDB key store persisted crypto keys separately from auth, and `encryption-runtime.ts` ran a full state machine managing activate/deactivate transitions. All of that complexity existed to track a single boolean.

```typescript
// Before — 3 steps, async, stateful
const ydoc = new Y.Doc({ guid: id });
const encryption = attachEncryption(ydoc, { encryptionKeys });
const tables = encryption.attachTables(defs);

await encryption.unlock(keys);
```

Now keys are read lazily at construction and registration happens atomically inside one factory call:

```typescript
// After — sync, lazy reads, no mutation hook
const workspace = createWorkspace({
	id,
	keyring: () => requireSignedIn(auth).keyring,
	tables: defs,
	kv: {},
});
// done, Y.Doc + keyring derivation + table registration + activation in one call
```

The encrypted Y.Map wrapper no longer maintains a dual-cache: it encrypts on write and decrypts on read, one direction each way. The encryption runtime, key stores, IndexedDB wrappers, and dual-cache logic are all gone. Encrypted stores derive their keyring when the workspace is constructed; same-owner key rotation needs a fresh `createWorkspace` call to affect already-attached stores.

```
Before:
  attachEncryption(ydoc, { encryptionKeys })
    ├── encryption-runtime.ts (state machine)
    ├── user-key-store.ts (IndexedDB persistence)
    └── y-keyvalue-lww-encrypted.ts (dual-cache: encrypted + decrypted)

After:
  createWorkspace({ id, keyring, tables, kv })
    └── reads keyring() once at construction, derives per-workspace key via HKDF
        └── y-keyvalue-lww-encrypted.ts (one-way: encrypt on write, decrypt on read)
```

Two follow-up improvements came along for the ride. First, fingerprint dedup: `onLogin` fires on every token refresh in the auth flow, which meant each fire was re-deriving HKDF keys — an expensive operation — even when the keys hadn't changed. `applyEncryptionKeys()` now computes a canonical fingerprint (`version:base64`, sorted) and skips the re-derivation when the fingerprint matches the last applied set.

Second, cached session boot: encrypted workspaces used to show empty content until the auth network roundtrip completed, because keys only arrived after the server responded. `AuthSession` now persists `encryptionKeys`, so apps can apply cached keys immediately on boot from `chrome.storage` or `localStorage` — no network wait, no flash of empty content.

Net change across 26 files: about 1700 lines deleted, 900 net lines removed (-2048/+1114).
````

**Why this works**: Opens with absurd contrast ("five moving parts for one boolean"), shows code before/after, uses a composition tree instead of listing files, subordinates secondary improvements with "came along for the ride," closes with one line of stats.

##### Example: Feature PR (sequential journey + bold topic sentences + protocol notation + casual close)

````
The tab-manager extension needs to tell a browser extension to close tabs, open URLs, and list connected devices. Epicenter already syncs shared state between devices via Yjs CRDTs through a Durable Object relay, but sync is one-way. You can read shared state, but you can't ask another device to *do* something. That gap is what this PR fills.

The core addition is peer-to-peer RPC over the existing WebSocket sync layer. But getting there required fixing a few things that were already slightly wrong, and the whole journey ends with the `sync-client` package being collapsed into the workspace module entirely.

---

**First, a small correction: SYNC_STATUS was documented as a heartbeat but it isn't one.**

Liveness is already handled by text-level ping/pong. What SYNC_STATUS actually needs to do is track whether the client has local changes that haven't reached the server yet — the "Saving..."/"Saved" UX. The fix makes that explicit:

1. Client increments `localVersion` on every doc update, setting `hasLocalChanges = true` immediately
2. After a 100ms quiet period, it sends a `[100, localVersion]` probe to the server
3. Server echoes the raw bytes back (zero parsing cost — it doesn't care what's in them)
4. Client compares the echoed version and clears `hasLocalChanges` when caught up

---

**The Durable Object message handler needed a cleaner return shape before RPC could be added.**

The old handler returned an optional-fields bag — `{ response?, broadcast?, persistAttachment? }` — and the caller had to guess which combination of fields was actually set. Replacing it with a discriminated union makes each case unambiguous:

```typescript
type MessageResult =
  | { action: 'reply'; data: Uint8Array }
  | { action: 'broadcast'; data: Uint8Array; shouldPersistAttachment: boolean }
  | { action: 'forward'; targetClientId: number; data: Uint8Array; onMissReply?: Uint8Array }
```

---

**Now the RPC protocol itself.**

Wire format uses lib0 varints, with JSON only for the payload:

```
REQUEST:  [101] [0=REQ] [requestId] [targetClientId] [requesterClientId] [action] [jsonInput]
RESPONSE: [101] [1=RES] [requestId] [requesterClientId]                           [jsonResult]
```

The DO is a dumb relay. It forwards a REQUEST to the target peer if they're connected, or synthesizes a PeerOffline RESPONSE if they're not. No RPC logic lives in the server — it just routes bytes.

```typescript
const ext = workspace.collaboration.peers
  .list()
  .find((p) => p.replicaId === 'browser-extension');

const { data, error } = await workspace.collaboration.dispatch(
  'tabs_close',
  { tabIds: [1, 2] },
  { to: ext.connId, signal: AbortSignal.timeout(10_000) },
);
```

23 commits on top of the encryption branch. 61 files changed, +3571/-1048. Stacks on #1591 — merge that first.
````

(Truncated for skill length — the full PR also covers typed RPC contracts with `InferRpcMap`, awareness unification, and the sync-client package collapse, each with their own bold topic sentence and code examples.)

**Why this works**: Opens with the concrete need ("tell a browser extension to close tabs"), walks through each prerequisite in build order, uses bold topic sentences with `---` for pacing, shows protocol notation inline, ends with casual stats and stacking note.
