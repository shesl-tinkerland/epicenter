# Svelte 5 Pattern: Syncing External State with createSubscriber

I've been working on syncing Yjs CRDTs with Svelte 5 and landed on a clean pattern using `createSubscriber`. Thought I'd share.

## The Problem

You have an external data source (WebSocket, IndexedDB, Yjs, Firebase, etc.) with its own observation API. You want Svelte components to react when it changes—without manual invalidation.

## The Pattern

```
┌─────────────────────────────────────────────────────────────┐
│                     EXTERNAL SOURCE                         │
│                  (Yjs, WebSocket, DB, etc.)                 │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ observe()
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    createSubscriber                         │
│                                                             │
│   ┌─────────────┐    update()     ┌──────────────────┐     │
│   │   Shadow    │ ◄────────────── │    Observer      │     │
│   │   $state    │                 │    Callback      │     │
│   └─────────────┘                 └──────────────────┘     │
│         │                                                   │
│         │ subscribe()                                       │
│         ▼                                                   │
│   ┌─────────────┐                                          │
│   │  Reactive   │                                          │
│   │   Getter    │ ──────────────────────────────────────┐  │
│   └─────────────┘                                       │  │
└─────────────────────────────────────────────────────────│──┘
                              │                           │
                              │ read                      │ mutate
                              ▼                           ▼
┌─────────────────────────────────────────────────────────────┐
│                     SVELTE COMPONENT                        │
│                                                             │
│   $effect(() => console.log(wrapper.value))   // reactive   │
│   wrapper.set('new value')                    // mutation   │
└─────────────────────────────────────────────────────────────┘
```

**Key insight**: Mutations go UP to the source. The source notifies the observer. The observer updates shadow state. Svelte reacts. You never mutate `$state` directly from components.

## Minimal Example

```typescript
// reactive-counter.svelte.ts
import { createSubscriber } from 'svelte/reactivity';

export function reactiveCounter(externalStore: ExternalStore) {
	// 1. Shadow state (mirrors external source)
	let count = $state(externalStore.get());

	// 2. Lazy subscriber (attaches observer only when read in reactive context)
	const subscribe = createSubscriber((update) => {
		const unsubscribe = externalStore.onChange((newValue) => {
			count = newValue; // Update shadow state
			update(); // Signal Svelte
		});
		return unsubscribe;
	});

	// 3. Return reactive wrapper
	return {
		get value() {
			subscribe(); // Attach observer if in reactive context
			return count; // Return shadow state
		},
		increment() {
			externalStore.set(count + 1); // Mutate source, NOT $state
		},
	};
}
```

## Usage in Component

```svelte
<script>
	import { reactiveCounter } from './reactive-counter.svelte';

	const counter = reactiveCounter(myExternalStore);
</script>

<p>Count: {counter.value}</p>
<button onclick={() => counter.increment()}>+1</button>
```

## Why This Works

1. **Lazy subscription**: Observer only attaches when `value` is read in a reactive context (`$effect`, `$derived`, template)
2. **Auto cleanup**: When no reactive consumers exist, `createSubscriber` calls your cleanup function
3. **Single source of truth**: External store owns the data; `$state` is just a reactive mirror

## Real World: Yjs Table to Readonly View

```typescript
import { createSubscriber } from 'svelte/reactivity';

export function readonlyTable(yjsTable: YjsTableHelper) {
	const subscribe = createSubscriber((update) => {
		return yjsTable.observeChanges(() => {
			update();
		});
	});

	return {
		get all(): Row[] {
			subscribe();
			return yjsTable.getAllValid();
		},
		byId(id: string): Row | undefined {
			subscribe();
			return yjsTable.get(id);
		},
	};
}
```

## The Flow

```
Component calls yjsTable.upsert({ id: '1', title: 'Hello' })
    │
    ▼
yjsTable.upsert() ─── writes to ──► Yjs Y.Map
    │
    │ (Yjs fires observer)
    ▼
observeChanges callback fires
    │
    ▼
update() called
    │
    ▼
Svelte re-renders components reading `all` or `byId(id)`
```

No manual invalidation. No stale mirror state. No writable view API.

The pattern is not Yjs-specific. It works for any external store with an
observe or subscribe API where the external store remains the source of truth.

## Further Reading

For a consumer-focused guide with more examples (BroadcastChannel, IntersectionObserver, and more), see [Using createSubscriber](./using-createsubscriber.md). For the version signal, reference counting, and `render_effect` internals, see [How createSubscriber Works](./how-createsubscriber-works.md). For choosing between `$state` and `createSubscriber`, see [`$state` vs `createSubscriber`: Who Owns the Reactivity?](./state-vs-createsubscriber-who-owns-reactivity.md).
