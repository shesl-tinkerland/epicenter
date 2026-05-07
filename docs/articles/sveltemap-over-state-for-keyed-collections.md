# Reactive Views Over $state for Keyed Collections

When your data has IDs, workspace rows, conversations, recordings, and similar
records should not live in a `$state` array. Use the domain source directly and
derive the array form with `$derived` when you need it for rendering.

## The Problem

Say you have a list of conversations, each with an `id`. The tempting thing is:

```typescript
let conversations = $state<Conversation[]>(readAll());
```

This works until you need to look one up:

```typescript
const metadata = $derived(conversations.find((c) => c.id === conversationId));
```

That is O(n) on every access. Svelte also tracks the whole array, so updating
one conversation re-renders anything that reads `conversations`, even if a
component only cares about a single row.

## Workspace Tables

Workspace tables use `fromTable()` from `@epicenter/svelte`. It returns a
readonly view with two reads:

```typescript
const conversationsView = fromTable(workspace.tables.conversations);

const conversations = $derived(
	conversationsView.all.toSorted((a, b) => b.updatedAt - a.updatedAt),
);

const metadata = $derived(conversationsView.byId(conversationId));
```

`view.all` returns the current valid rows as an array. `view.byId(id)` returns
one row or `undefined`. Both reads subscribe when used in a Svelte reactive
context and read live table data without subscribing when used imperatively.

The `$derived` array is a cached materialization. It recomputes when the table
view invalidates, and it gives consumers a stable reference until then. That is
important for TanStack Table, which can loop if `get data()` returns a new
array on every access.

## The Three-Layer Pattern

Every workspace-backed collection in this codebase should follow this shape:

```typescript
// 1. View: reactive source, private, suffixed with View
const recordingsView = fromTable(workspace.tables.recordings);

// 2. Derived array: cached materialization, private, no suffix
const recordings = $derived(
	recordingsView.all.toSorted((a, b) => b.timestamp - a.timestamp),
);

// 3. Getter: public API
return {
	get recordings() {
		return recordings;
	},
	byId: recordingsView.byId,
};
```

Naming convention: `{name}View` to `{name}` to `get {name}()`.

## What fromTable Does

`fromTable()` wraps a workspace table with Svelte's public `createSubscriber`
primitive:

```typescript
export function fromTable<TRow extends BaseRow>(table: Table<TRow>) {
	const subscribe = createSubscriber((update) => table.observe(update));

	return {
		get all(): TRow[] {
			subscribe();
			return table.getAllValid();
		},
		byId(id: string): TRow | undefined {
			subscribe();
			return table.get(id).data ?? undefined;
		},
	};
}
```

The table remains the source of truth. Writes go through the workspace table or
workspace actions. The view has no write methods and no manual dispose method.
Svelte attaches the observer when a tracked read appears and detaches it after
the last tracked reader is gone.

## When SvelteMap Still Fits

Use `SvelteMap` for non-workspace keyed state that you own locally, such as
browser tabs keyed by native tab ID. It is still the right primitive when the
map itself is the mutable source.

Use `$state<T[]>` when:

- Items do not have stable IDs, such as terminal history entries.
- Order is the primary concern, such as open file tab order.
- The list is small local UI state.
- Values are primitives without row identity.

The rule: if it is a workspace table, use `fromTable()`. If it is local keyed
state, use `SvelteMap`. If it is sequential local state, use `$state<T[]>`.
