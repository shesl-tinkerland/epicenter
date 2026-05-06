import type {
	InferKvValue,
	KvDefinitions,
	Kv,
} from '@epicenter/workspace';
import { createSubscriber } from 'svelte/reactivity';

/**
 * Create a reactive binding to a single workspace KV key.
 *
 * Mirrors Svelte 5's `fromStore()` pattern: wraps an external data source
 * into a reactive `{ current }` box. Reading `.current` is reactive (triggers
 * re-renders). Writing `.current` calls `kv.set()` under the hood.
 *
 * The observer fires on both local and remote changes (Yjs CRDT sync).
 * On delete, falls back to the KV definition's `defaultValue` via `kv.get()`.
 *
 * The binding is tied to one KV store for its lifetime. If the workspace
 * changes, remount the component or recreate the binding at that lifecycle
 * boundary.
 *
 * @example
 * ```typescript
 * const selectedFolderId = fromKv(workspaceClient.kv, 'selectedFolderId');
 *
 * // Read (reactive):
 * console.log(selectedFolderId.current); // FolderId | null
 *
 * // Write (calls kv.set):
 * selectedFolderId.current = newFolderId;
 * ```
 */
export function fromKv<
	TDefs extends KvDefinitions,
	K extends keyof TDefs & string,
>(
	kv: Kv<TDefs>,
	key: K,
): { current: InferKvValue<TDefs[K]> } {
	const subscribe = createSubscriber((update) => {
		return kv.observe(key, update);
	});

	return {
		get current() {
			subscribe();
			return kv.get(key);
		},
		set current(newValue: InferKvValue<TDefs[K]>) {
			kv.set(key, newValue);
		},
	};
}
