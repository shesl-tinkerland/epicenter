/**
 * Conflict Resolution Comparison: YKeyValue vs YKeyValueLww
 *
 * Answers: "How do the two YKeyValue implementations differ in conflict behavior?"
 *
 * Compares positional conflict resolution (clientID-based, unpredictable winner)
 * against timestamp-based LWW (later edit always wins) under identical concurrent
 * edit scenarios. Also measures storage overhead and confirms API parity.
 */

import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import {
	YKeyValue,
	type YKeyValueEntry,
} from '../document/y-keyvalue/index.js';
import {
	YKeyValueLww,
	type YKeyValueLwwEntry,
} from '../document/y-keyvalue/index.js';

/** Helper to create a YKeyValue with fresh doc */
function createKv<T>() {
	const doc = new Y.Doc();
	const array = doc.getArray<YKeyValueEntry<T>>('data');
	return { doc, array, kv: new YKeyValue(array) };
}

/** Helper to create a YKeyValueLww with fresh doc */
function createKvLww<T>() {
	const doc = new Y.Doc();
	const array = doc.getArray<YKeyValueLwwEntry<T>>('data');
	return { doc, array, kv: new YKeyValueLww(array) };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Conflict Resolution
// ═══════════════════════════════════════════════════════════════════════════════

describe('conflict resolution: YKeyValue vs YKeyValueLww', () => {
	/**
	 * THE KEY DIFFERENCE: Same concurrent edits, different winners.
	 *
	 * YKeyValue: Winner determined by clientID (arbitrary)
	 * YKeyValueLww: Winner determined by timestamp (chronological)
	 */
	test('same concurrent conflict yields clientID winner vs timestamp winner', () => {
		// Two clients edit the same key while offline
		const doc1 = new Y.Doc({ guid: 'shared' });
		const doc2 = new Y.Doc({ guid: 'shared' });

		// For YKeyValue (positional)
		const arr1 = doc1.getArray<YKeyValueEntry<string>>('positional');
		const arr2 = doc2.getArray<YKeyValueEntry<string>>('positional');

		// For YKeyValueLww (timestamp)
		const arrLww1 = doc1.getArray<YKeyValueLwwEntry<string>>('lww');
		const arrLww2 = doc2.getArray<YKeyValueLwwEntry<string>>('lww');

		// Simulate: Client 1 edits at "2pm" (earlier), Client 2 edits at "3pm" (later)
		// For LWW, we use explicit timestamps to control the outcome
		arr1.push([{ key: 'x', val: 'client-1-2pm' }]);
		arrLww1.push([{ key: 'x', val: 'client-1-2pm', ts: 1000 }]); // Earlier

		arr2.push([{ key: 'x', val: 'client-2-3pm' }]);
		arrLww2.push([{ key: 'x', val: 'client-2-3pm', ts: 2000 }]); // Later

		// Sync
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
		Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));

		// Create KV wrappers
		const kv1 = new YKeyValue(arr1);
		const kv2 = new YKeyValue(arr2);
		const kvLww1 = new YKeyValueLww(arrLww1);
		const kvLww2 = new YKeyValueLww(arrLww2);

		// YKeyValue: Both converge, but winner is based on clientID (unpredictable)
		expect(kv1.get('x')).toBe(kv2.get('x')); // Convergence guaranteed

		// YKeyValueLww: Both converge, winner is ALWAYS the later timestamp
		expect(kvLww1.get('x')).toBe('client-2-3pm'); // Later edit wins
		expect(kvLww2.get('x')).toBe('client-2-3pm'); // Both see same result

		console.log('\n=== Conflict Resolution Comparison ===');
		console.log(
			`YKeyValue winner: "${kv1.get('x')}" (clientID-based, unpredictable)`,
		);
		console.log(
			`YKeyValueLww winner: "${kvLww1.get('x')}" (timestamp-based, later edit wins)`,
		);
	});

	test('YKeyValue: ~50% chance earlier edit wins (clientID lottery)', () => {
		let earlierWins = 0;
		const trials = 100;

		for (let i = 0; i < trials; i++) {
			const doc1 = new Y.Doc({ guid: `test-${i}` });
			const doc2 = new Y.Doc({ guid: `test-${i}` });

			const arr1 = doc1.getArray<YKeyValueEntry<string>>('data');
			const arr2 = doc2.getArray<YKeyValueEntry<string>>('data');

			arr1.push([{ key: 'x', val: 'earlier' }]);
			arr2.push([{ key: 'x', val: 'later' }]);

			Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
			Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));

			const kv1 = new YKeyValue(arr1);
			if (kv1.get('x') === 'earlier') earlierWins++;
		}

		const earlierPercent = (earlierWins / trials) * 100;
		console.log(
			`\nYKeyValue: earlier edit won ${earlierPercent.toFixed(0)}% of ${trials} trials`,
		);

		// Should be roughly 50/50 (within 30-70% range)
		expect(earlierWins).toBeGreaterThan(20);
		expect(earlierWins).toBeLessThan(80);
	});

	test('YKeyValueLww: 100% later timestamp wins', () => {
		let laterWins = 0;
		const trials = 100;

		for (let i = 0; i < trials; i++) {
			const doc1 = new Y.Doc({ guid: `test-${i}` });
			const doc2 = new Y.Doc({ guid: `test-${i}` });

			const arr1 = doc1.getArray<YKeyValueLwwEntry<string>>('data');
			const arr2 = doc2.getArray<YKeyValueLwwEntry<string>>('data');

			// Randomize which doc gets higher timestamp
			const ts1 = Math.random() * 1000;
			const ts2 = Math.random() * 1000;

			arr1.push([{ key: 'x', val: 'from-1', ts: ts1 }]);
			arr2.push([{ key: 'x', val: 'from-2', ts: ts2 }]);

			Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
			Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));

			const kv1 = new YKeyValueLww(arr1);
			const expected = ts1 > ts2 ? 'from-1' : 'from-2';
			if (kv1.get('x') === expected) laterWins++;
		}

		console.log(`\nYKeyValueLww: correct winner ${laterWins}/${trials} times`);
		expect(laterWins).toBe(trials); // Must be 100%
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// Storage Comparison
// ═══════════════════════════════════════════════════════════════════════════════

describe('storage comparison', () => {
	test('LWW entries serialize larger than positional entries', () => {
		const { array: arr } = createKv<string>();
		const { array: arrLww } = createKvLww<string>();

		// Push equivalent entries
		arr.push([{ key: 'test', val: 'value' }]);
		arrLww.push([{ key: 'test', val: 'value', ts: Date.now() }]);

		const kvEntry = arr.get(0);
		const lwwEntry = arrLww.get(0);

		console.log('\n=== Entry Size Comparison ===');
		console.log('YKeyValue entry:', JSON.stringify(kvEntry));
		console.log('YKeyValueLww entry:', JSON.stringify(lwwEntry));
		console.log(
			`Size difference: +${JSON.stringify(lwwEntry).length - JSON.stringify(kvEntry).length} bytes per entry`,
		);

		// LWW adds ~15-20 bytes for the timestamp field
		expect(JSON.stringify(lwwEntry).length).toBeGreaterThan(
			JSON.stringify(kvEntry).length,
		);
	});

	test('LWW document remains bounded but larger after many updates', () => {
		const { doc: doc1, kv: kv1 } = createKv<number>();
		const { doc: doc2, kv: kv2 } = createKvLww<number>();

		// Perform 1000 updates on 10 keys
		for (let round = 0; round < 100; round++) {
			for (let key = 0; key < 10; key++) {
				kv1.set(`key-${key}`, round);
				kv2.set(`key-${key}`, round);
			}
		}

		const size1 = Y.encodeStateAsUpdate(doc1).length;
		const size2 = Y.encodeStateAsUpdate(doc2).length;

		console.log('\n=== Document Size After 1000 Operations ===');
		console.log(`YKeyValue: ${size1} bytes`);
		console.log(`YKeyValueLww: ${size2} bytes`);
		console.log(`LWW overhead: ${((size2 / size1 - 1) * 100).toFixed(1)}%`);

		// Both should maintain constant size (10 entries)
		// LWW will be slightly larger due to timestamp field
		expect(size2).toBeGreaterThan(size1);
		expect(size2).toBeLessThan(size1 * 2); // But not dramatically larger
	});
});
