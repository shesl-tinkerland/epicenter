import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import {
	type EncryptedBlob,
	generateEncryptionKey,
	getKeyVersion,
	isEncryptedBlob,
} from '../crypto';
import type { YKeyValueLwwEntry } from './y-keyvalue-lww';
import { createEncryptedYkvLww } from './y-keyvalue-lww-encrypted';

type PlainChange<T> =
	| { action: 'add'; newValue: T }
	| { action: 'update'; newValue: T }
	| { action: 'delete' };

function syncDocs(from: Y.Doc, to: Y.Doc): void {
	Y.applyUpdate(to, Y.encodeStateAsUpdate(from));
}

function syncBoth(doc1: Y.Doc, doc2: Y.Doc): void {
	syncDocs(doc1, doc2);
	syncDocs(doc2, doc1);
}

function createEncryptedBlob<T>(value: T, key: Uint8Array, entryKey: string): EncryptedBlob {
	const helperDoc = new Y.Doc({ guid: 'helper-blob' });
	const helperArray =
		helperDoc.getArray<YKeyValueLwwEntry<EncryptedBlob | T>>('helper-data');
	const helperKv = createEncryptedYkvLww<T>(helperArray, new Map([[1, key]]));

	helperKv.set(entryKey, value);

	const entry = helperArray.toArray()[0];
	if (!entry || !isEncryptedBlob(entry.val)) {
		throw new Error('Expected helper entry to be encrypted');
	}

	return entry.val;
}

describe('createEncryptedYkvLww', () => {
	describe('Basic encrypted operations', () => {
		test('set() encrypts, get() decrypts round-trip', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedYkvLww<string>(yarray, new Map([[1, key]]));

			kv.set('secret', 'hello-world');

			expect(kv.get('secret')).toBe('hello-world');
		});

		test('values in Y.Array are encrypted', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedYkvLww<string>(yarray, new Map([[1, key]]));

			kv.set('secret', 'cipher-me');

			const [entry] = yarray.toArray();
			expect(entry).toBeDefined();
			expect(isEncryptedBlob(entry?.val)).toBe(true);
		});

		test('complex object round-trip', () => {
			type Bookmark = { url: string; title: string };
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | Bookmark>>('data');
			const kv = createEncryptedYkvLww<Bookmark>(yarray, new Map([[1, key]]));

			const value: Bookmark = { url: 'https://bank.com', title: 'My Bank' };
			kv.set('site', value);

			expect(kv.get('site')).toEqual(value);
		});

		test('delete works', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedYkvLww<string>(yarray, new Map([[1, key]]));

			kv.set('k', 'v');
			kv.delete('k');

			expect(kv.get('k')).toBeUndefined();
		});

		test('has works', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedYkvLww<string>(yarray, new Map([[1, key]]));

			kv.set('k', 'v');
			expect(kv.has('k')).toBe(true);

			kv.delete('k');
			expect(kv.has('k')).toBe(false);
		});

		test('entries returns decrypted values', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedYkvLww<string>(yarray, new Map([[1, key]]));

			kv.set('a', '1');
			kv.set('b', '2');
			kv.set('c', '3');

			const values = new Map<string, string>();
			for (const [entryKey, entry] of kv.entries())
				values.set(entryKey, entry.val);

			expect(values.get('a')).toBe('1');
			expect(values.get('b')).toBe('2');
			expect(values.get('c')).toBe('3');
		});
	});

	describe('No-key passthrough', () => {
		test('when no key is provided, set/get work as plaintext', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedYkvLww<string>(yarray);

			kv.set('plain', 'text');

			expect(kv.get('plain')).toBe('text');
		});

		test('when no key is provided, yarray contains plaintext', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedYkvLww<string>(yarray);

			kv.set('plain', 'raw-value');

			const [entry] = yarray.toArray();
			expect(entry?.val).toBe('raw-value');
			expect(isEncryptedBlob(entry?.val)).toBe(false);
		});

		test('zero overhead: wrapper.map mirrors inner behavior', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedYkvLww<string>(yarray);

			kv.set('x', '10');
			kv.set('y', '20');

			expect(kv.get('x')).toBe('10');
			expect(kv.get('y')).toBe('20');
			expect(kv.cachedSize).toBe(2);
		});
	});

	describe('Observer decryption', () => {
		test('observer receives decrypted values on add', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedYkvLww<string>(yarray, new Map([[1, key]]));

			const events: Array<{ key: string; change: PlainChange<string> }> = [];
			kv.observe((changes) => {
				for (const [entryKey, change] of changes)
					events.push({ key: entryKey, change });
			});

			kv.set('foo', 'bar');

			expect(events).toEqual([
				{ key: 'foo', change: { action: 'add', newValue: 'bar' } },
			]);
		});

		test('observer receives decrypted values on update', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedYkvLww<string>(yarray, new Map([[1, key]]));

			kv.set('foo', 'first');

			const events: Array<{ key: string; change: PlainChange<string> }> = [];
			kv.observe((changes) => {
				for (const [entryKey, change] of changes)
					events.push({ key: entryKey, change });
			});

			kv.set('foo', 'second');

			expect(events).toEqual([
				{
					key: 'foo',
					change: {
						action: 'update',
						newValue: 'second',
					},
				},
			]);
		});

		test('observer receives correct action on delete', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedYkvLww<string>(yarray, new Map([[1, key]]));

			kv.set('foo', 'value');

			const events: Array<{ key: string; change: PlainChange<string> }> = [];
			kv.observe((changes) => {
				for (const [entryKey, change] of changes)
					events.push({ key: entryKey, change });
			});

			kv.delete('foo');

			expect(events).toEqual([{ key: 'foo', change: { action: 'delete' } }]);
		});

		test('unobserve stops notifications', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedYkvLww<string>(yarray, new Map([[1, key]]));

			let count = 0;
			const handler = () => {
				count++;
			};

			kv.observe(handler);
			kv.set('a', '1');
			kv.unobserve(handler);
			kv.set('b', '2');

			expect(count).toBe(1);
		});
	});

	describe('Mixed plaintext/encrypted (migration)', () => {
		test('reads plaintext entries as-is when key exists', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');

			yarray.push([{ key: 'plaintext', val: 'plaintext-value', ts: 1000 }]);

			const kv = createEncryptedYkvLww<string>(yarray, new Map([[1, key]]));
			expect(kv.get('plaintext')).toBe('plaintext-value');
		});

		test('reads encrypted entries correctly', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');

			const encrypted = createEncryptedBlob('encrypted-value', key, 'enc');
			yarray.push([{ key: 'enc', val: encrypted, ts: 1000 }]);

			const kv = createEncryptedYkvLww<string>(yarray, new Map([[1, key]]));
			expect(kv.get('enc')).toBe('encrypted-value');
		});

		test('mixed entries: some plaintext, some encrypted', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');

			const encrypted = createEncryptedBlob('new-secret', key, 'new');
			yarray.push([
				{ key: 'old', val: 'old-plaintext', ts: 1000 },
				{ key: 'new', val: encrypted, ts: 1001 },
			]);

			const kv = createEncryptedYkvLww<string>(yarray, new Map([[1, key]]));

			expect(kv.get('old')).toBe('old-plaintext');
			expect(kv.get('new')).toBe('new-secret');
		});
	});

	describe('wrapper.map always plaintext', () => {
		test('wrapper.map contains decrypted values after set', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedYkvLww<string>(yarray, new Map([[1, key]]));

			kv.set('k', 'plain-view');

			expect(kv.get('k')).toBe('plain-view');
			expect(isEncryptedBlob(yarray.toArray()[0]?.val)).toBe(true);
		});

		test('wrapper.map updated by observer on remote sync', () => {
			const key = generateEncryptionKey();

			const doc1 = new Y.Doc({ guid: 'shared' });
			const doc2 = new Y.Doc({ guid: 'shared' });

			const yarray1 =
				doc1.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const yarray2 =
				doc2.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');

			const kv1 = createEncryptedYkvLww<string>(yarray1, new Map([[1, key]]));
			const kv2 = createEncryptedYkvLww<string>(yarray2, new Map([[1, key]]));

			kv1.set('shared-key', 'from-doc1');
			syncDocs(doc1, doc2);

			expect(kv2.get('shared-key')).toBe('from-doc1');
			expect(kv2.get('shared-key')).toBe('from-doc1');
		});
	});

	describe('Two-device sync with same key', () => {
		test('encrypted value syncs and decrypts correctly', () => {
			const key = generateEncryptionKey();

			const doc1 = new Y.Doc({ guid: 'shared' });
			const doc2 = new Y.Doc({ guid: 'shared' });

			const yarray1 =
				doc1.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const yarray2 =
				doc2.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');

			const kv1 = createEncryptedYkvLww<string>(yarray1, new Map([[1, key]]));
			const kv2 = createEncryptedYkvLww<string>(yarray2, new Map([[1, key]]));

			kv1.set('token', 'abc-123');
			syncDocs(doc1, doc2);

			expect(kv2.get('token')).toBe('abc-123');
			expect(isEncryptedBlob(yarray2.toArray()[0]?.val)).toBe(true);
		});

		test('LWW conflict resolution works through encryption', () => {
			const key = generateEncryptionKey();

			const doc1 = new Y.Doc({ guid: 'shared' });
			const doc2 = new Y.Doc({ guid: 'shared' });

			const yarray1 =
				doc1.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const yarray2 =
				doc2.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');

			yarray1.push([
				{
					key: 'x',
					val: createEncryptedBlob('from-client-1-earlier', key, 'x'),
					ts: 1000,
				},
			]);
			yarray2.push([
				{
					key: 'x',
					val: createEncryptedBlob('from-client-2-later', key, 'x'),
					ts: 2000,
				},
			]);

			syncBoth(doc1, doc2);

			const kv1 = createEncryptedYkvLww<string>(yarray1, new Map([[1, key]]));
			const kv2 = createEncryptedYkvLww<string>(yarray2, new Map([[1, key]]));

			expect(kv1.get('x')).toBe('from-client-2-later');
			expect(kv2.get('x')).toBe('from-client-2-later');
		});

		test('both docs converge to same decrypted value', () => {
			const key = generateEncryptionKey();

			const doc1 = new Y.Doc({ guid: 'shared' });
			const doc2 = new Y.Doc({ guid: 'shared' });

			const yarray1 =
				doc1.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const yarray2 =
				doc2.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');

			const kv1 = createEncryptedYkvLww<string>(yarray1, new Map([[1, key]]));
			const kv2 = createEncryptedYkvLww<string>(yarray2, new Map([[1, key]]));

			kv1.set('shared', 'value-from-doc1');
			kv2.set('shared', 'value-from-doc2');

			syncBoth(doc1, doc2);

			expect(kv1.get('shared')).toBe(kv2.get('shared'));
		});
	});

	describe('Key becomes available mid-session', () => {
		test('passthrough then encrypted via activateEncryption', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedYkvLww<string>(yarray);

			kv.set('old-1', 'alpha');
			kv.set('old-2', 'beta');

			const key = generateEncryptionKey();
			kv.activateEncryption(new Map([[1, key]]));
			kv.set('new-1', 'encrypted-c');

			expect(kv.get('old-1')).toBe('alpha');
			expect(kv.get('old-2')).toBe('beta');
			expect(kv.get('new-1')).toBe('encrypted-c');

			const entries = yarray.toArray();
			const old1 = entries.find((entry) => entry.key === 'old-1');
			const old2 = entries.find((entry) => entry.key === 'old-2');
			const newer = entries.find((entry) => entry.key === 'new-1');

			expect(isEncryptedBlob(old1?.val)).toBe(true);
			expect(isEncryptedBlob(old2?.val)).toBe(true);
			expect(isEncryptedBlob(newer?.val)).toBe(true);
		});

		test('activateEncryption encrypts existing plaintext entries in-place', () => {
			const ydoc = new Y.Doc({ guid: 'encrypt-plaintext-on-activate' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedYkvLww<string>(yarray);

			kv.set('pt-1', 'plain-a');
			kv.set('pt-2', 'plain-b');

			expect(isEncryptedBlob(yarray.toArray()[0]?.val)).toBe(false);
			expect(isEncryptedBlob(yarray.toArray()[1]?.val)).toBe(false);

			const key = generateEncryptionKey();
			kv.activateEncryption(new Map([[1, key]]));

			const entries = yarray.toArray();
			const pt1 = entries.find((entry) => entry.key === 'pt-1');
			const pt2 = entries.find((entry) => entry.key === 'pt-2');

			expect(kv.get('pt-1')).toBe('plain-a');
			expect(kv.get('pt-2')).toBe('plain-b');
			expect(isEncryptedBlob(pt1?.val)).toBe(true);
			expect(isEncryptedBlob(pt2?.val)).toBe(true);
		});
	});

	describe('Batch operations', () => {
		test('set in batch is readable via get in same batch', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedYkvLww<string>(yarray, new Map([[1, key]]));

			let valueInBatch: string | undefined;
			ydoc.transact(() => {
				kv.set('foo', 'bar');
				valueInBatch = kv.get('foo');
			});

			expect(valueInBatch).toBe('bar');
			expect(kv.get('foo')).toBe('bar');
		});

		test('multiple sets in batch all visible via entries', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedYkvLww<string>(yarray, new Map([[1, key]]));

			const keysInBatch: string[] = [];
			ydoc.transact(() => {
				kv.set('a', '1');
				kv.set('b', '2');
				kv.set('c', '3');

				for (const [entryKey] of kv.entries()) keysInBatch.push(entryKey);
			});

			expect(keysInBatch.sort()).toEqual(['a', 'b', 'c']);
		});
	});

	describe('Mode transitions', () => {
		test('starts unencrypted when no key provided', () => {
			const ydoc = new Y.Doc({ guid: 'mode-no-key-start' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedYkvLww<string>(yarray);

			kv.set('a', 'hello');
			const raw = yarray.toArray().find((e) => e.key === 'a');
			expect(isEncryptedBlob(raw?.val)).toBe(false);
		});

		test('starts encrypted when key provided', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'mode-key-start' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedYkvLww<string>(yarray, new Map([[1, key]]));

			kv.set('a', 'hello');
			const raw = yarray.toArray().find((e) => e.key === 'a');
			expect(isEncryptedBlob(raw?.val)).toBe(true);
		});

		test('plaintext → encrypted via activateEncryption(key)', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'mode-plaintext-to-encrypted' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedYkvLww<string>(yarray);

			kv.set('before', 'plaintext');
			const rawBefore = yarray.toArray().find((e) => e.key === 'before');
			expect(isEncryptedBlob(rawBefore?.val)).toBe(false);

			kv.activateEncryption(new Map([[1, key]]));

			kv.set('after', 'encrypted');
			const rawAfter = yarray.toArray().find((e) => e.key === 'after');
			expect(isEncryptedBlob(rawAfter?.val)).toBe(true);
		});
	});

	describe('Error containment', () => {
		test('corrupted blob does not crash observation', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'containment-corrupt-no-crash' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedYkvLww<string>(yarray, new Map([[1, key]]));

			kv.set('good-1', 'value-1');
			kv.set('good-2', 'value-2');

			yarray.push([
				{
					key: 'corrupt',
					val: (() => {
						const blob = createEncryptedBlob('broken', key, 'corrupt');
						const tampered = new Uint8Array(blob);
						tampered[2] = tampered[2]! ^ 0xff;
						return tampered as EncryptedBlob;
					})(),
					ts: Date.now(),
				},
			]);

			expect(kv.get('corrupt')).toBeUndefined();
			expect(kv.get('good-1')).toBe('value-1');
			expect(kv.get('good-2')).toBe('value-2');
			expect(kv.failedDecryptCount).toBe(1);
		});

		test('observation continues after decrypt failure', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'containment-observer-continues' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedYkvLww<string>(yarray, new Map([[1, key]]));

			kv.set('good', 'still-works');
			yarray.push([
				{
					key: 'corrupt',
					val: (() => {
						const blob = createEncryptedBlob('broken', key, 'corrupt');
						const tampered = new Uint8Array(blob);
						tampered[2] = tampered[2]! ^ 0xff;
						return tampered as EncryptedBlob;
					})(),
					ts: Date.now(),
				},
			]);

			kv.set('new-good', 'appears-after-failure');

			expect(kv.get('good')).toBe('still-works');
			expect(kv.get('new-good')).toBe('appears-after-failure');
			expect(kv.get('corrupt')).toBeUndefined();
			expect(kv.failedDecryptCount).toBe(1);
		});
	});

	describe('Key transition (activateEncryption)', () => {
		test('plaintext entries remain accessible after activateEncryption', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({
				guid: 'key-transition-plaintext-stays-readable',
			});
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedYkvLww<string>(yarray);

			kv.set('pt-1', 'plain-a');
			kv.set('pt-2', 'plain-b');
			kv.activateEncryption(new Map([[1, key]]));

			expect(kv.get('pt-1')).toBe('plain-a');
			expect(kv.get('pt-2')).toBe('plain-b');
		});

		test('new writes after activateEncryption encrypt', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'key-transition-new-writes-encrypt' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedYkvLww<string>(yarray);

			kv.set('before', 'plaintext-before-key');
			kv.activateEncryption(new Map([[1, key]]));
			kv.set('after', 'encrypted-after-key');

			const afterEntry = yarray
				.toArray()
				.find((entry) => entry.key === 'after');
			expect(afterEntry).toBeDefined();
			expect(isEncryptedBlob(afterEntry?.val)).toBe(true);
		});

		test('activateEncryption with key rotation preserves entries via fallback', () => {
			const key1 = generateEncryptionKey();
			const key2 = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'key-transition-synthetic-events' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedYkvLww<string>(yarray, new Map([[1, key1]]));

			kv.set('a', 'alpha');
			kv.set('b', 'beta');

			const events: Array<{ key: string; change: PlainChange<string> }> = [];
			kv.observe((changes) => {
				for (const [entryKey, change] of changes)
					events.push({ key: entryKey, change });
			});

			// Rotate from key1 to key2 — entries should be preserved via fallback
			kv.activateEncryption(new Map([[2, key2], [1, key1]]));
			expect(kv.failedDecryptCount).toBe(0);
			expect(kv.get('a')).toBe('alpha');
			expect(kv.get('b')).toBe('beta');

			// No delete events — entries were recovered via previous key fallback
			const deleteEvents = events.filter(
				(event) => event.change.action === 'delete',
			);
			expect(deleteEvents.length).toBe(0);

			// Rotate back to key1 — entries re-encrypted with key2, fallback to key2 works
			events.length = 0;
			kv.activateEncryption(new Map([[1, key1], [2, key2]]));
			expect(kv.failedDecryptCount).toBe(0);
			expect(kv.get('a')).toBe('alpha');
			expect(kv.get('b')).toBe('beta');
		});

		test('activateEncryption does not emit spurious events for plaintext re-encryption', () => {
			const ydoc = new Y.Doc({ guid: 'no-spurious-reencrypt' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			// Start without encryption — entries stored as plaintext
			const kv = createEncryptedYkvLww<string>(yarray);

			kv.set('a', 'alpha');
			kv.set('b', 'beta');

			const events: Array<{ key: string; change: PlainChange<string> }> = [];
			kv.observe((changes) => {
				for (const [entryKey, change] of changes)
					events.push({ key: entryKey, change });
			});

			// Activate encryption — plaintext entries get encrypted under the hood
			// but their decrypted values don't change. Should fire zero events.
			const key = generateEncryptionKey();
			kv.activateEncryption(new Map([[1, key]]));

			expect(events).toEqual([]);
			expect(kv.get('a')).toBe('alpha');
			expect(kv.get('b')).toBe('beta');
		});

		test('multi-version keyring decrypts entries with different keyVersions and re-encrypts with current', () => {
			const key1 = generateEncryptionKey();
			const key2 = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'multi-version-keyring' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');

			// Write entries with key1 (version 1)
			const kv = createEncryptedYkvLww<string>(yarray, new Map([[1, key1]]));
			kv.set('a', 'alpha');
			kv.set('b', 'beta');

			// Verify blobs have keyVersion 1
			for (const entry of yarray.toArray()) {
				if (isEncryptedBlob(entry.val)) {
					expect(getKeyVersion(entry.val)).toBe(1);
				}
			}

			// Activate with a two-key keyring: v2 is current, v1 is fallback
			kv.activateEncryption(new Map([[2, key2], [1, key1]]));

			// Values still readable
			expect(kv.get('a')).toBe('alpha');
			expect(kv.get('b')).toBe('beta');
			expect(kv.failedDecryptCount).toBe(0);

			// Blobs re-encrypted with v2
			for (const entry of yarray.toArray()) {
				if (isEncryptedBlob(entry.val)) {
					expect(getKeyVersion(entry.val)).toBe(2);
				}
			}

			// New writes also get version 2
			kv.set('c', 'gamma');
			const cEntry = yarray.toArray().find((e) => e.key === 'c');
			expect(isEncryptedBlob(cEntry?.val)).toBe(true);
			if (isEncryptedBlob(cEntry?.val)) {
				expect(getKeyVersion(cEntry.val)).toBe(2);
			}
		});
	});

	describe('deactivateEncryption', () => {
		test('clears key so new writes are plaintext', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'deactivate-plaintext-writes' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedYkvLww<string>(yarray, new Map([[1, key]]));

			kv.set('enc', 'secret');
			expect(isEncryptedBlob(yarray.toArray().find((e) => e.key === 'enc')?.val)).toBe(true);

			kv.deactivateEncryption();

			kv.set('plain', 'visible');
			const plainEntry = yarray.toArray().find((e) => e.key === 'plain');
			expect(isEncryptedBlob(plainEntry?.val)).toBe(false);
			expect(plainEntry?.val).toBe('visible');
		});

		test('clears decrypted cache', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'deactivate-clears-cache' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedYkvLww<string>(yarray, new Map([[1, key]]));

			kv.set('a', 'alpha');
			kv.set('b', 'beta');
			expect(kv.cachedSize).toBe(2);

			kv.deactivateEncryption();
			expect(kv.cachedSize).toBe(0);
		});


		test('encrypted entries unreadable after deactivation', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'deactivate-unreadable' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedYkvLww<string>(yarray, new Map([[1, key]]));

			kv.set('secret', 'hidden');
			kv.deactivateEncryption();

			// Encrypted blob still in yarray but can't be decrypted without key
			expect(kv.get('secret')).toBeUndefined();
		});

		test('reactivation restores access to encrypted entries', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'deactivate-reactivate' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedYkvLww<string>(yarray, new Map([[1, key]]));

			kv.set('secret', 'hidden');
			kv.deactivateEncryption();
			expect(kv.get('secret')).toBeUndefined();

			kv.activateEncryption(new Map([[1, key]]));
			expect(kv.get('secret')).toBe('hidden');
		});
	});
});
