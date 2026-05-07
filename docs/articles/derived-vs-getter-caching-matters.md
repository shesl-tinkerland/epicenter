# `$derived` vs Getter: Both Reactive, Only One Caches

A getter that reads from a reactive source is reactive. For workspace tables,
that source is usually a `fromTable()` view. Svelte tracks `view.all` or
`view.byId(id)` when the read happens inside a reactive context. So why bother
with `$derived`?

Caching.

## The Two Approaches

```typescript
function createSavedTabState() {
	const tabsView = fromTable(workspaceClient.tables.savedTabs);

	// Option A: $derived computes once, then caches until tabsView changes
	const tabs = $derived(
		tabsView.all.toSorted((a, b) => b.savedAt - a.savedAt),
	);

	return {
		get tabs() {
			return tabs;
		},
	};

	// Option B: plain getter recomputes on every access
	return {
		get tabs() {
			return tabsView.all.toSorted((a, b) => b.savedAt - a.savedAt);
		},
	};
}
```

Both are reactive. Both return fresh table data. The difference is what happens
when `tabs` is read multiple times in the same render cycle.

## What Each Does

`$derived` creates a reactive signal. The expression runs once when its
dependencies change, and the result is memoized. Ten reads in the same cycle
all hit the cache. The sort runs once.

A plain getter is just a JavaScript getter. Every access runs
`view.all.toSorted(...)` from scratch. Ten reads means ten array snapshots and
ten sorts.

## Why It Matters

For a list of 20 saved tabs, the performance difference is negligible. The
principle matters because state modules are public surfaces. As datasets grow
or more consumers read the same derived value, caching pays off. `$derived` is
also the idiomatic Svelte 5 way to say "computed from reactive state."

## The Rule

Prefer `$derived` for any computation derived from reactive state. Use a getter
only to expose the derived value as a public API.

```typescript
const tabs = $derived(
	tabsView.all.toSorted((a, b) => b.savedAt - a.savedAt),
);

return {
	get tabs() {
		return tabs;
	},
};
```

This is the three-layer pattern: `fromTable` reactive view, `$derived` cached
computation, then a public getter. The getter is a pass-through, not a
computation site.
