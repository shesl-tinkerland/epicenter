import type { InferKvValue } from '@epicenter/workspace';
import { SvelteMap } from 'svelte/reactivity';
import { whispering } from '$lib/whispering/whispering';
import { whisperingKv } from '$lib/workspace';

const KV_DEFINITIONS = whisperingKv;
type KvKey = keyof typeof KV_DEFINITIONS & string;

type KvDefs = typeof KV_DEFINITIONS;

function createSettings() {
	const map = new SvelteMap<string, unknown>();

	// Initialize SvelteMap with current values for ALL KV keys.
	// kv.get() always returns a valid value (stored value or defaultValue).
	for (const key of Object.keys(KV_DEFINITIONS) as KvKey[]) {
		map.set(key, whispering.kv.get(key));
	}

	// Single observer for ALL KV changes (local or remote).
	// Observer updates SvelteMap → components re-render per-key.
	whispering.kv.observeAll((changes) => {
		for (const [key, change] of changes) {
			if (change.type === 'set') {
				map.set(key, change.value);
			} else if (change.type === 'delete') {
				// On delete, restore default value so map always has a value
				map.set(key, whispering.kv.get(key));
			}
		}
	});

	return {
		/**
		 * Get a synced workspace setting. Returns the current value from the
		 * reactive SvelteMap. Components reading this will re-render when the
		 * value changes (from local writes OR remote sync).
		 */
		get<K extends keyof KvDefs & string>(key: K): InferKvValue<KvDefs[K]> {
			return map.get(key) as InferKvValue<KvDefs[K]>;
		},

		/**
		 * Set a synced workspace setting. Writes to Yjs KV, which fires the
		 * observer, which updates the SvelteMap. Unidirectional — never set
		 * the SvelteMap directly.
		 */
		set<K extends keyof KvDefs & string>(
			key: K,
			value: InferKvValue<KvDefs[K]>,
		) {
			whispering.kv.set(key, value);
		},

		/**
		 * Reset all workspace settings to their default values.
		 * Iterates every KV definition and writes its defaultValue to Yjs KV.
		 */
		reset() {
			for (const key of Object.keys(KV_DEFINITIONS) as KvKey[]) {
				whispering.kv.set(key, KV_DEFINITIONS[key].defaultValue());
			}
		},
	};
}

export const settings = createSettings();
