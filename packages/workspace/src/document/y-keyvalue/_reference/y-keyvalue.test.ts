/**
 * YKeyValue Conflict Resolution Tests
 *
 * These tests verify positional conflict resolution in `YKeyValue`, especially
 * for concurrent offline edits and transaction-batched writes. The suite documents
 * deterministic convergence semantics and single-writer map synchronization behavior.
 *
 * Key behaviors:
 * - Concurrent writes converge deterministically using rightmost/clientID ordering.
 * - Batch reads and observers expose pending state correctly during transactions.
 *
 * See also:
 * - `y-keyvalue-lww.ts` for timestamp-based LWW alternative
 */
import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { YKeyValue, type YKeyValueEntry } from './y-keyvalue';

describe('YKeyValue', () => {
	describe('Basic Operations', () => {
		test('set stores value and get retrieves it', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
			const kv = new YKeyValue(yarray);

			kv.set('foo', 'bar');
			expect(kv.get('foo')).toBe('bar');
		});

		test('set overwrites existing value', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
			const kv = new YKeyValue(yarray);

			kv.set('foo', 'first');
			kv.set('foo', 'second');
			expect(kv.get('foo')).toBe('second');
		});

		test('delete removes value', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
			const kv = new YKeyValue(yarray);

			kv.set('foo', 'bar');
			kv.delete('foo');
			expect(kv.get('foo')).toBeUndefined();
			expect(kv.has('foo')).toBe(false);
		});

		test('has returns false before set and true after set', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
			const kv = new YKeyValue(yarray);

			expect(kv.has('foo')).toBe(false);
			kv.set('foo', 'bar');
			expect(kv.has('foo')).toBe(true);
		});
	});

	describe('Change Events', () => {
		test('fires add event when new key is set', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
			const kv = new YKeyValue(yarray);

			const events: Array<{ key: string; action: string }> = [];
			kv.observe((changes) => {
				for (const [key, change] of changes) {
					events.push({ key, action: change.action });
				}
			});

			kv.set('foo', 'bar');
			expect(events).toEqual([{ key: 'foo', action: 'add' }]);
		});

		test('fires update event when existing key is changed', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
			const kv = new YKeyValue(yarray);

			kv.set('foo', 'first');

			const events: Array<{
				key: string;
				action: string;
				oldValue?: string;
				newValue?: string;
			}> = [];
			kv.observe((changes) => {
				for (const [key, change] of changes) {
					events.push({
						key,
						action: change.action,
						oldValue: 'oldValue' in change ? change.oldValue : undefined,
						newValue: 'newValue' in change ? change.newValue : undefined,
					});
				}
			});

			kv.set('foo', 'second');
			expect(events).toEqual([
				{ key: 'foo', action: 'update', oldValue: 'first', newValue: 'second' },
			]);
		});

		test('fires delete event when key is removed', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
			const kv = new YKeyValue(yarray);

			kv.set('foo', 'bar');

			const events: Array<{ key: string; action: string }> = [];
			kv.observe((changes) => {
				for (const [key, change] of changes) {
					events.push({ key, action: change.action });
				}
			});

			kv.delete('foo');
			expect(events).toEqual([{ key: 'foo', action: 'delete' }]);
		});
	});

	describe('Sync Behavior - Two Document Simulation', () => {
		/**
		 * Simulates two clients editing the same key while offline,
		 * then syncing their changes.
		 *
		 * This test demonstrates that YKeyValue conflict resolution is
		 * deterministic based on Yjs's clientID ordering.
		 */
		test('concurrent updates: winner is determined by clientID ordering', () => {
			// Create two separate Y.Docs (simulating two offline clients)
			const doc1 = new Y.Doc({ guid: 'shared' });
			const doc2 = new Y.Doc({ guid: 'shared' });

			const array1 = doc1.getArray<YKeyValueEntry<string>>('data');
			const array2 = doc2.getArray<YKeyValueEntry<string>>('data');

			const kv1 = new YKeyValue(array1);
			const kv2 = new YKeyValue(array2);

			// Client 1 sets value (imagine this is at 10:00am)
			kv1.set('doc', 'from-client-1');

			// Client 2 sets value (imagine this is at 10:05am - LATER)
			kv2.set('doc', 'from-client-2');

			// Now sync: Apply doc1's changes to doc2, then doc2's changes to doc1
			const state1 = Y.encodeStateAsUpdate(doc1);
			const state2 = Y.encodeStateAsUpdate(doc2);

			// Apply in order: doc1 → doc2, doc2 → doc1
			Y.applyUpdate(doc2, state1);
			Y.applyUpdate(doc1, state2);

			// Both docs should now have the same value
			// The winner is determined by Yjs's clientID-based ordering
			const value1 = kv1.get('doc');
			const value2 = kv2.get('doc');

			// Both clients should see the same value (convergence)
			expect(value1).toBe(value2);

			// The key insight: the winner is deterministic based on clientIDs
			console.log(`Winner: ${value1}`);
		});

		test('concurrent updates converge to same value across all clients', () => {
			// Run the sync test multiple times to observe if outcome varies
			const results: Array<string | undefined> = [];

			for (let i = 0; i < 10; i++) {
				const doc1 = new Y.Doc({ guid: `shared-${i}` });
				const doc2 = new Y.Doc({ guid: `shared-${i}` });

				const array1 = doc1.getArray<YKeyValueEntry<string>>('data');
				const array2 = doc2.getArray<YKeyValueEntry<string>>('data');

				const kv1 = new YKeyValue(array1);
				const kv2 = new YKeyValue(array2);

				kv1.set('key', `value-from-1-iteration-${i}`);
				kv2.set('key', `value-from-2-iteration-${i}`);

				const state1 = Y.encodeStateAsUpdate(doc1);
				const state2 = Y.encodeStateAsUpdate(doc2);

				Y.applyUpdate(doc2, state1);
				Y.applyUpdate(doc1, state2);

				// Convergence check: both should have same value
				expect(kv1.get('key')).toBe(kv2.get('key'));

				results.push(kv1.get('key'));
			}

			// Log results to observe pattern
			console.log('Concurrent update winners:', results);
		});

		test('delete vs update race condition', () => {
			// Client 1 deletes a key
			// Client 2 updates the same key
			// Who wins after sync?

			const doc1 = new Y.Doc({ guid: 'shared-delete-test' });
			const doc2 = new Y.Doc({ guid: 'shared-delete-test' });

			const array1 = doc1.getArray<YKeyValueEntry<string>>('data');
			const array2 = doc2.getArray<YKeyValueEntry<string>>('data');

			// First, establish initial state in both docs
			const kv1 = new YKeyValue(array1);
			kv1.set('doc', 'initial');

			// Sync initial state to doc2
			Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
			const kv2 = new YKeyValue(array2);

			expect(kv2.get('doc')).toBe('initial');

			// Now, while offline:
			// Client 1 DELETES the key
			kv1.delete('doc');

			// Client 2 UPDATES the key (doesn't know about the delete)
			kv2.set('doc', 'updated-value');

			// Sync both ways
			const state1 = Y.encodeStateAsUpdate(doc1);
			const state2 = Y.encodeStateAsUpdate(doc2);

			Y.applyUpdate(doc2, state1);
			Y.applyUpdate(doc1, state2);

			// What's the result?
			const value1 = kv1.get('doc');
			const value2 = kv2.get('doc');

			// Both should converge
			expect(value1).toBe(value2);

			// Log the outcome
			console.log(`Delete vs Update result: ${value1 ?? 'DELETED'}`);
		});
	});

	describe('Array Cleanup Behavior', () => {
		test('duplicate keys are cleaned up on construction', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');

			// Manually push duplicate keys (simulating sync artifacts)
			yarray.push([{ key: 'foo', val: 'first' }]);
			yarray.push([{ key: 'bar', val: 'only' }]);
			yarray.push([{ key: 'foo', val: 'second' }]); // duplicate

			expect(yarray.length).toBe(3);

			// Creating YKeyValue should clean up duplicates
			const kv = new YKeyValue(yarray);

			// Rightmost 'foo' should win
			expect(kv.get('foo')).toBe('second');
			expect(kv.get('bar')).toBe('only');

			// Array should be cleaned (duplicates removed)
			expect(yarray.length).toBe(2);
		});

		test('rightmost entry wins during cleanup', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');

			// Push same key multiple times
			yarray.push([{ key: 'x', val: 'A' }]);
			yarray.push([{ key: 'x', val: 'B' }]);
			yarray.push([{ key: 'x', val: 'C' }]);

			const kv = new YKeyValue(yarray);

			// Rightmost ('C') should win
			expect(kv.get('x')).toBe('C');
			expect(yarray.length).toBe(1);
		});
	});

	describe('Storage Efficiency', () => {
		test('maintains constant size regardless of update count', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray = ydoc.getArray<YKeyValueEntry<number>>('data');
			const kv = new YKeyValue(yarray);

			for (let i = 0; i < 100; i++) {
				kv.set('counter', i);
			}

			expect(yarray.length).toBe(1);
			expect(kv.get('counter')).toBe(99);
		});

		test('size scales with unique keys, not operations', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
			const kv = new YKeyValue(yarray);

			for (let i = 0; i < 10; i++) {
				kv.set(`key-${i}`, `value-${i}`);
			}

			for (let round = 0; round < 10; round++) {
				for (let i = 0; i < 10; i++) {
					kv.set(`key-${i}`, `value-${i}-round-${round}`);
				}
			}

			expect(yarray.length).toBe(10);
		});
	});

	describe('Documentation of Conflict Resolution Behavior', () => {
		/**
		 * This test documents the EXACT conflict resolution mechanism.
		 *
		 * YKeyValue uses "rightmost wins" - when the cleanup logic runs
		 * (either on construction or via observer), it iterates right-to-left
		 * and keeps only the first occurrence of each key.
		 *
		 * This is DETERMINISTIC given a specific array state, and the array
		 * state after CRDT merge is also deterministic based on Yjs's
		 * clientID-based ordering algorithm.
		 */
		test('conflict resolution is positional (rightmost wins)', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');

			// Manually construct a conflicted state
			yarray.push([{ key: 'x', val: 'leftmost' }]);
			yarray.push([{ key: 'y', val: 'middle-y' }]);
			yarray.push([{ key: 'x', val: 'rightmost' }]); // This should win

			const kv = new YKeyValue(yarray);

			expect(kv.get('x')).toBe('rightmost');
			expect(kv.get('y')).toBe('middle-y');
		});

		/**
		 * This test shows that there are NO TIMESTAMPS in the current implementation.
		 * The entry structure is just { key, val } - no temporal information.
		 */
		test('entries have no timestamp field', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
			const kv = new YKeyValue(yarray);

			kv.set('foo', 'bar');

			// Inspect the raw array entry
			const entry = yarray.get(0);
			expect(entry).toEqual({ key: 'foo', val: 'bar' });

			// No timestamp field exists
			expect('timestamp' in entry).toBe(false);
			expect('time' in entry).toBe(false);
			expect('updatedAt' in entry).toBe(false);
		});
	});

	describe('Single-Writer Architecture', () => {
		/**
		 * These tests verify the single-writer architecture where:
		 * - set() writes to `pending` and Y.Array, but NOT to `map`
		 * - Observer is the sole writer to `map` and clears `pending` after processing
		 * - get()/has() check `pending` first, then `map`
		 * - entries() yields from both pending and map
		 */

		describe('Batch operations with nested reads', () => {
			test('get() returns value set in same batch', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
				const kv = new YKeyValue(yarray);

				let valueInBatch: string | undefined;

				ydoc.transact(() => {
					kv.set('foo', 'bar');
					valueInBatch = kv.get('foo');
				});

				expect(valueInBatch).toBe('bar');
				expect(kv.get('foo')).toBe('bar');
			});

			test('has() returns true for key set in same batch', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
				const kv = new YKeyValue(yarray);

				let hasInBatch: boolean = false;

				ydoc.transact(() => {
					kv.set('foo', 'bar');
					hasInBatch = kv.has('foo');
				});

				expect(hasInBatch).toBe(true);
			});

			test('multiple updates to same key in batch - final value wins', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
				const kv = new YKeyValue(yarray);

				const valuesInBatch: Array<string | undefined> = [];

				ydoc.transact(() => {
					kv.set('foo', 'first');
					valuesInBatch.push(kv.get('foo'));

					kv.set('foo', 'second');
					valuesInBatch.push(kv.get('foo'));

					kv.set('foo', 'third');
					valuesInBatch.push(kv.get('foo'));
				});

				expect(valuesInBatch).toEqual(['first', 'second', 'third']);
				expect(kv.get('foo')).toBe('third');
			});

			test('get() returns updated value when updating existing key in batch', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
				const kv = new YKeyValue(yarray);

				// Set initial value outside batch
				kv.set('foo', 'initial');

				let valueInBatch: string | undefined;

				ydoc.transact(() => {
					kv.set('foo', 'updated');
					valueInBatch = kv.get('foo');
				});

				expect(valueInBatch).toBe('updated');
				expect(kv.get('foo')).toBe('updated');
			});
		});

		describe('Batch with deletes', () => {
			test('delete() removes key set in same batch', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
				const kv = new YKeyValue(yarray);

				let hasAfterDelete: boolean = true;

				ydoc.transact(() => {
					kv.set('foo', 'bar');
					kv.delete('foo');
					hasAfterDelete = kv.has('foo');
				});

				// During batch: pending was cleared by delete(), pendingDeletes blocks stale read
				expect(hasAfterDelete).toBe(false);

				// After batch: key was set then deleted, so it should not exist
				expect(kv.has('foo')).toBe(false);
			});

			test('set() after delete() in same batch restores key', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
				const kv = new YKeyValue(yarray);

				// Set initial value
				kv.set('foo', 'initial');

				let valueInBatch: string | undefined;

				ydoc.transact(() => {
					kv.delete('foo');
					kv.set('foo', 'restored');
					valueInBatch = kv.get('foo');
				});

				expect(valueInBatch).toBe('restored');
				expect(kv.get('foo')).toBe('restored');
			});

			test('delete() on pre-existing key during batch', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
				const kv = new YKeyValue(yarray);

				kv.set('foo', 'bar');
				expect(kv.has('foo')).toBe(true);

				ydoc.transact(() => {
					kv.delete('foo');
				});

				expect(kv.has('foo')).toBe(false);
			});
		});

		describe('entries() iterator', () => {
			test('entries() yields pending values during batch', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
				const kv = new YKeyValue(yarray);

				const keysInBatch: string[] = [];

				ydoc.transact(() => {
					kv.set('a', '1');
					kv.set('b', '2');
					kv.set('c', '3');

					for (const [key] of kv.entries()) {
						keysInBatch.push(key);
					}
				});

				expect(keysInBatch.sort()).toEqual(['a', 'b', 'c']);
			});

			test('entries() yields both pending and map values', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
				const kv = new YKeyValue(yarray);

				// Set initial values (will be in map after transaction)
				kv.set('existing', 'old');

				const entriesInBatch: Array<[string, string]> = [];

				ydoc.transact(() => {
					kv.set('new', 'value');

					for (const [key, entry] of kv.entries()) {
						entriesInBatch.push([key, entry.val]);
					}
				});

				expect(entriesInBatch).toContainEqual(['existing', 'old']);
				expect(entriesInBatch).toContainEqual(['new', 'value']);
			});

			test('entries() prefers pending over map for same key', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
				const kv = new YKeyValue(yarray);

				kv.set('foo', 'old');

				let valueInBatch: string | undefined;

				ydoc.transact(() => {
					kv.set('foo', 'new');

					for (const [key, entry] of kv.entries()) {
						if (key === 'foo') valueInBatch = entry.val;
					}
				});

				expect(valueInBatch).toBe('new');
			});

			test('entries() does not yield duplicates', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
				const kv = new YKeyValue(yarray);

				kv.set('foo', 'old');

				let fooCount = 0;

				ydoc.transact(() => {
					kv.set('foo', 'new');

					for (const [key] of kv.entries()) {
						if (key === 'foo') fooCount++;
					}
				});

				expect(fooCount).toBe(1);
			});
		});

		describe('Pending cleanup', () => {
			test('pending is cleared after transaction ends', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
				const kv = new YKeyValue(yarray);

				ydoc.transact(() => {
					kv.set('foo', 'bar');
				});

				// After transaction, observer has fired and cleared pending
				expect(kv.get('foo')).toBe('bar');
				expect(kv.map.has('foo')).toBe(true);
			});

			test('multiple transactions preserve prior keys and apply updates', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
				const kv = new YKeyValue(yarray);

				ydoc.transact(() => {
					kv.set('a', '1');
					kv.set('b', '2');
				});

				expect(kv.get('a')).toBe('1');
				expect(kv.get('b')).toBe('2');

				ydoc.transact(() => {
					kv.set('c', '3');
					kv.set('a', 'updated');
				});

				expect(kv.get('a')).toBe('updated');
				expect(kv.get('b')).toBe('2');
				expect(kv.get('c')).toBe('3');
			});
		});

		describe('Observer behavior', () => {
			test('observer fires once per batch, not per set()', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
				const kv = new YKeyValue(yarray);

				let observerCallCount = 0;
				kv.observe(() => {
					observerCallCount++;
				});

				ydoc.transact(() => {
					kv.set('a', '1');
					kv.set('b', '2');
					kv.set('c', '3');
				});

				expect(observerCallCount).toBe(1);
			});

			test('observer receives all changes from batch', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
				const kv = new YKeyValue(yarray);

				const changedKeys: string[] = [];
				kv.observe((changes) => {
					for (const [key] of changes) {
						changedKeys.push(key);
					}
				});

				ydoc.transact(() => {
					kv.set('a', '1');
					kv.set('b', '2');
					kv.set('c', '3');
				});

				expect(changedKeys.sort()).toEqual(['a', 'b', 'c']);
			});
		});

		describe('Edge cases', () => {
			test('set() with undefined value', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray =
					ydoc.getArray<YKeyValueEntry<string | undefined>>('data');
				const kv = new YKeyValue(yarray);

				kv.set('foo', undefined);
				expect(kv.has('foo')).toBe(true);
				expect(kv.get('foo')).toBeUndefined();
			});

			test('rapid set/get cycles always return the latest value', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueEntry<number>>('data');
				const kv = new YKeyValue(yarray);

				for (let i = 0; i < 100; i++) {
					kv.set('counter', i);
					expect(kv.get('counter')).toBe(i);
				}

				expect(kv.get('counter')).toBe(99);
			});

			test('delete during batch: has() returns false immediately', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
				const kv = new YKeyValue(yarray);

				kv.set('foo', 'bar');

				let hasDuringBatch: boolean = true;

				ydoc.transact(() => {
					kv.delete('foo');
					hasDuringBatch = kv.has('foo');
				});

				// During batch, has() correctly returns false via pendingDeletes
				expect(hasDuringBatch).toBe(false);
				// After batch, still correctly returns false
				expect(kv.has('foo')).toBe(false);
			});

			test('delete then get in batch returns undefined', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
				const kv = new YKeyValue(yarray);

				kv.set('foo', 'bar');

				let getDuringBatch: string | undefined = 'not-cleared';

				ydoc.transact(() => {
					kv.delete('foo');
					getDuringBatch = kv.get('foo');
				});

				expect(getDuringBatch).toBeUndefined();
				expect(kv.get('foo')).toBeUndefined();
			});

			test('delete then set in batch returns new value', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
				const kv = new YKeyValue(yarray);

				kv.set('foo', 'bar');

				let getDuringBatch: string | undefined;

				ydoc.transact(() => {
					kv.delete('foo');
					expect(kv.get('foo')).toBeUndefined();
					kv.set('foo', 'new');
					getDuringBatch = kv.get('foo');
				});

				expect(getDuringBatch).toBe('new');
				expect(kv.get('foo')).toBe('new');
				expect(kv.has('foo')).toBe(true);
			});

			test('double delete is idempotent', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
				const kv = new YKeyValue(yarray);

				kv.set('foo', 'bar');

				ydoc.transact(() => {
					kv.delete('foo');
					kv.delete('foo'); // second delete should be no-op
					expect(kv.has('foo')).toBe(false);
				});

				expect(kv.has('foo')).toBe(false);
				expect(kv.get('foo')).toBeUndefined();
			});

			test('entries skips pending deletes', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
				const kv = new YKeyValue(yarray);

				kv.set('a', '1');
				kv.set('b', '2');
				kv.set('c', '3');

				let keysDuringBatch: string[] = [];

				ydoc.transact(() => {
					kv.delete('b');
					keysDuringBatch = Array.from(kv.entries()).map(([key]) => key);
				});

				expect(keysDuringBatch).not.toContain('b');
				expect(keysDuringBatch).toContain('a');
				expect(keysDuringBatch).toContain('c');
			});

			test('observer clears pendingDeletes', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
				const kv = new YKeyValue(yarray);

				kv.set('foo', 'bar');

				ydoc.transact(() => {
					kv.delete('foo');
					expect(kv.has('foo')).toBe(false); // pendingDeletes active
				});

				// After transaction, observer has fired and cleared pendingDeletes
				// Verify by setting a new value: if pendingDeletes wasn't cleared,
				// has() would still return false incorrectly
				kv.set('foo', 'baz');
				expect(kv.has('foo')).toBe(true);
				expect(kv.get('foo')).toBe('baz');
			});

			test('set+delete in same batch leaves no sticky pendingDeletes', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
				const kv = new YKeyValue(yarray);

				// set then delete in same batch: entry added+deleted from yarray
				ydoc.transact(() => {
					kv.set('foo', 'bar');
					kv.delete('foo');
				});

				// After transaction, pendingDeletes should be clear (observer processed deletion)
				// Verify: a subsequent set should work correctly
				kv.set('foo', 'new');
				expect(kv.has('foo')).toBe(true);
				expect(kv.get('foo')).toBe('new');
			});

			test('remote set after local delete is not masked by pendingDeletes', () => {
				const ydoc1 = new Y.Doc({ guid: 'test' });
				const yarray1 = ydoc1.getArray<YKeyValueEntry<string>>('data');
				const kv1 = new YKeyValue(yarray1);

				const ydoc2 = new Y.Doc({ guid: 'test' });
				const yarray2 = ydoc2.getArray<YKeyValueEntry<string>>('data');
				const kv2 = new YKeyValue(yarray2);

				// Both clients have the key
				kv1.set('foo', 'original');
				Y.applyUpdate(ydoc2, Y.encodeStateAsUpdate(ydoc1));

				// Client 1 deletes
				kv1.delete('foo');
				expect(kv1.has('foo')).toBe(false);

				// Client 2 sets a new value
				kv2.set('foo', 'remote-value');

				// Sync client 2's update to client 1
				Y.applyUpdate(ydoc1, Y.encodeStateAsUpdate(ydoc2));

				// Client 1 should see the remote value: pendingDeletes must not mask it
				expect(kv1.has('foo')).toBe(true);
				expect(kv1.get('foo')).toBe('remote-value');
			});

			test('set→delete→set triple sequence in batch', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
				const kv = new YKeyValue(yarray);

				kv.set('foo', 'initial');

				let finalGet: string | undefined;

				ydoc.transact(() => {
					kv.set('foo', 'first');
					kv.delete('foo');
					expect(kv.get('foo')).toBeUndefined();
					kv.set('foo', 'final');
					finalGet = kv.get('foo');
				});

				expect(finalGet).toBe('final');
				expect(kv.get('foo')).toBe('final');
				expect(kv.has('foo')).toBe(true);
			});

			test('delete→set→delete triple sequence in batch', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
				const kv = new YKeyValue(yarray);

				kv.set('foo', 'original');

				ydoc.transact(() => {
					kv.delete('foo');
					expect(kv.has('foo')).toBe(false);
					kv.set('foo', 'revived');
					expect(kv.get('foo')).toBe('revived');
					kv.delete('foo');
					expect(kv.has('foo')).toBe(false);
				});

				expect(kv.has('foo')).toBe(false);
				expect(kv.get('foo')).toBeUndefined();
			});

			test('set→set→delete triple sequence in batch: second set survives', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
				const kv = new YKeyValue(yarray);

				ydoc.transact(() => {
					kv.set('foo', 'first');
					kv.set('foo', 'second');
					expect(kv.get('foo')).toBe('second');
					kv.delete('foo');
					// During batch, pendingDeletes blocks reads
					expect(kv.has('foo')).toBe(false);
				});

				// After batch: two set() calls in same batch push two entries to yarray.
				// delete() only removes the first matching entry via findIndex().
				// The second entry survives, and the observer processes it as an add.
				// This is a known edge case: the second set's entry "wins".
				expect(kv.has('foo')).toBe(true);
				expect(kv.get('foo')).toBe('second');
			});

			test('delete non-existent key is no-op', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
				const kv = new YKeyValue(yarray);

				// Delete a key that was never set: should not throw
				kv.delete('never-existed');
				expect(kv.has('never-existed')).toBe(false);
				expect(kv.get('never-existed')).toBeUndefined();

				// Also test inside a batch
				ydoc.transact(() => {
					kv.delete('also-never-existed');
					expect(kv.has('also-never-existed')).toBe(false);
				});
			});

			test('pendingDeletes beats pending: set then delete in batch', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueEntry<string>>('data');
				const kv = new YKeyValue(yarray);

				kv.set('foo', 'original');

				let getDuringBatch: string | undefined = 'sentinel';

				ydoc.transact(() => {
					// set() adds to pending, clears pendingDeletes
					kv.set('foo', 'updated');
					expect(kv.get('foo')).toBe('updated');

					// delete() clears pending, adds to pendingDeletes
					kv.delete('foo');
					getDuringBatch = kv.get('foo');
				});

				// During batch, pendingDeletes should have taken precedence
				expect(getDuringBatch).toBeUndefined();
				expect(kv.has('foo')).toBe(false);
			});

			test('remote add for different key does not clear unrelated pendingDeletes', () => {
				const ydoc1 = new Y.Doc({ guid: 'test' });
				const yarray1 = ydoc1.getArray<YKeyValueEntry<string>>('data');
				const kv1 = new YKeyValue(yarray1);

				const ydoc2 = new Y.Doc({ guid: 'test' });
				const yarray2 = ydoc2.getArray<YKeyValueEntry<string>>('data');
				const kv2 = new YKeyValue(yarray2);

				// Both clients have keys 'a' and 'b'
				kv1.set('a', '1');
				kv1.set('b', '2');
				Y.applyUpdate(ydoc2, Y.encodeStateAsUpdate(ydoc1));

				// Client 1 deletes 'a'
				kv1.delete('a');
				expect(kv1.has('a')).toBe(false);

				// Client 2 adds a completely new key 'c'
				kv2.set('c', '3');

				// Sync client 2's update to client 1
				Y.applyUpdate(ydoc1, Y.encodeStateAsUpdate(ydoc2));

				// 'a' should still be deleted: the remote add of 'c' should not affect it
				expect(kv1.has('a')).toBe(false);
				expect(kv1.get('a')).toBeUndefined();
				// 'c' should be visible
				expect(kv1.get('c')).toBe('3');
			});

			test('both clients delete same key', () => {
				const ydoc1 = new Y.Doc({ guid: 'test' });
				const yarray1 = ydoc1.getArray<YKeyValueEntry<string>>('data');
				const kv1 = new YKeyValue(yarray1);

				const ydoc2 = new Y.Doc({ guid: 'test' });
				const yarray2 = ydoc2.getArray<YKeyValueEntry<string>>('data');
				const kv2 = new YKeyValue(yarray2);

				// Both clients have the key
				kv1.set('foo', 'shared');
				Y.applyUpdate(ydoc2, Y.encodeStateAsUpdate(ydoc1));
				expect(kv2.get('foo')).toBe('shared');

				// Both delete independently
				kv1.delete('foo');
				kv2.delete('foo');

				// Sync both ways
				Y.applyUpdate(ydoc2, Y.encodeStateAsUpdate(ydoc1));
				Y.applyUpdate(ydoc1, Y.encodeStateAsUpdate(ydoc2));

				// Both should see it deleted
				expect(kv1.has('foo')).toBe(false);
				expect(kv2.has('foo')).toBe(false);
			});

			test('local set then remote delete of same key', () => {
				const ydoc1 = new Y.Doc({ guid: 'test' });
				const yarray1 = ydoc1.getArray<YKeyValueEntry<string>>('data');
				const kv1 = new YKeyValue(yarray1);

				const ydoc2 = new Y.Doc({ guid: 'test' });
				const yarray2 = ydoc2.getArray<YKeyValueEntry<string>>('data');
				const kv2 = new YKeyValue(yarray2);

				// Both clients have the key
				kv1.set('foo', 'original');
				Y.applyUpdate(ydoc2, Y.encodeStateAsUpdate(ydoc1));

				// Client 1 updates the key
				kv1.set('foo', 'updated');

				// Client 2 deletes the key
				kv2.delete('foo');

				// Sync both ways
				Y.applyUpdate(ydoc2, Y.encodeStateAsUpdate(ydoc1));
				Y.applyUpdate(ydoc1, Y.encodeStateAsUpdate(ydoc2));

				// Both should converge to the same value (positional resolution)
				expect(kv1.get('foo')).toBe(kv2.get('foo'));
				// The set wins over the delete (rightmost entry survives)
				expect(kv1.get('foo')).toBe('updated');
			});
		});
	});
});
