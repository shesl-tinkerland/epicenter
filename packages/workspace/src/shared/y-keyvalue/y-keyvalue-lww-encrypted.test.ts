import { describe, expect, test } from 'bun:test';
import {
	type EncryptedBlob,
	getKeyVersion,
	isEncryptedBlob,
} from '@epicenter/encryption';
import { randomBytes } from '@noble/ciphers/utils.js';
import * as Y from 'yjs';
import {
	createEncryptedYkvLww,
	type EncryptedYKeyValueLww,
} from './y-keyvalue-lww-encrypted';

/** Create a single-doc encrypted KV for tests. Skips the 4-line Y.Doc ceremony. */
function setup<T = string>(keyring?: ReadonlyMap<number, Uint8Array>) {
	const ydoc = new Y.Doc();
	const kv: EncryptedYKeyValueLww<T> = createEncryptedYkvLww<T>(ydoc, 'data');
	if (keyring) kv.activateEncryption(keyring);
	return { ydoc, yarray: kv.yarray, kv };
}

/** Construct and activate in one step. Replaces the old `initialKeyring` opt for tests. */
function setupActivated<T = string>(
	ydoc: Y.Doc,
	arrayKey: string,
	keyring: ReadonlyMap<number, Uint8Array>,
): EncryptedYKeyValueLww<T> {
	const kv = createEncryptedYkvLww<T>(ydoc, arrayKey);
	kv.activateEncryption(keyring);
	return kv;
}

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

function createEncryptedBlob<T>(
	value: T,
	key: Uint8Array,
	entryKey: string,
): EncryptedBlob {
	const helperDoc = new Y.Doc({ guid: 'helper-blob' });
	const helperKv = createEncryptedYkvLww<T>(helperDoc, 'helper-data');
	helperKv.activateEncryption(new Map([[1, key]]));

	helperKv.set(entryKey, value);

	const entry = helperKv.yarray.toArray()[0];
	if (!entry || !isEncryptedBlob(entry.val)) {
		throw new Error('Expected helper entry to be encrypted');
	}

	return entry.val;
}

describe('createEncryptedYkvLww', () => {
	describe('Basic encrypted operations', () => {
		test('set() encrypts, get() decrypts round-trip', () => {
			const key = randomBytes(32);
			const { kv } = setup(new Map([[1, key]]));

			kv.set('secret', 'hello-world');

			expect(kv.get('secret')).toBe('hello-world');
		});

		test('values in Y.Array are encrypted', () => {
			const key = randomBytes(32);
			const { kv, yarray } = setup(new Map([[1, key]]));

			kv.set('secret', 'cipher-me');

			const [entry] = yarray.toArray();
			expect(entry).toBeDefined();
			expect(isEncryptedBlob(entry?.val)).toBe(true);
		});

		test('complex object round-trip', () => {
			type Bookmark = { url: string; title: string };
			const key = randomBytes(32);
			const { kv } = setup<Bookmark>(new Map([[1, key]]));

			const value: Bookmark = { url: 'https://bank.com', title: 'My Bank' };
			kv.set('site', value);

			expect(kv.get('site')).toEqual(value);
		});

		test('delete works', () => {
			const key = randomBytes(32);
			const { kv } = setup(new Map([[1, key]]));

			kv.set('k', 'v');
			kv.delete('k');

			expect(kv.get('k')).toBeUndefined();
		});

		test('has works', () => {
			const key = randomBytes(32);
			const { kv } = setup(new Map([[1, key]]));

			kv.set('k', 'v');
			expect(kv.has('k')).toBe(true);

			kv.delete('k');
			expect(kv.has('k')).toBe(false);
		});

		test('entries returns decrypted values', () => {
			const key = randomBytes(32);
			const { kv } = setup(new Map([[1, key]]));

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
			const { kv } = setup();

			kv.set('plain', 'text');

			expect(kv.get('plain')).toBe('text');
		});

		test('when no key is provided, yarray contains plaintext', () => {
			const { kv, yarray } = setup();

			kv.set('plain', 'raw-value');

			const [entry] = yarray.toArray();
			expect(entry?.val).toBe('raw-value');
			expect(isEncryptedBlob(entry?.val)).toBe(false);
		});
	});

	describe('Observer decryption', () => {
		test('observer receives decrypted values on add', () => {
			const key = randomBytes(32);
			const { kv } = setup(new Map([[1, key]]));

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
			const key = randomBytes(32);
			const { kv } = setup(new Map([[1, key]]));

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
			const key = randomBytes(32);
			const { kv } = setup(new Map([[1, key]]));

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
			const key = randomBytes(32);
			const { kv } = setup(new Map([[1, key]]));

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
			const key = randomBytes(32);
			const { ydoc, yarray } = setup();

			yarray.push([{ key: 'plaintext', val: 'plaintext-value', ts: 1000 }]);

			const kv = setupActivated<string>(ydoc, 'data', new Map([[1, key]]));
			expect(kv.get('plaintext')).toBe('plaintext-value');
		});

		test('reads encrypted entries correctly', () => {
			const key = randomBytes(32);
			const { ydoc, yarray } = setup();

			const encrypted = createEncryptedBlob('encrypted-value', key, 'enc');
			yarray.push([{ key: 'enc', val: encrypted, ts: 1000 }]);

			const kv = setupActivated<string>(ydoc, 'data', new Map([[1, key]]));
			expect(kv.get('enc')).toBe('encrypted-value');
		});

		test('mixed entries: some plaintext, some encrypted', () => {
			const key = randomBytes(32);
			const { ydoc, yarray } = setup();

			const encrypted = createEncryptedBlob('new-secret', key, 'new');
			yarray.push([
				{ key: 'old', val: 'old-plaintext', ts: 1000 },
				{ key: 'new', val: encrypted, ts: 1001 },
			]);

			const kv = setupActivated<string>(ydoc, 'data', new Map([[1, key]]));

			expect(kv.get('old')).toBe('old-plaintext');
			expect(kv.get('new')).toBe('new-secret');
		});
	});

	describe('reads always return plaintext', () => {});

	describe('Two-device sync with same key', () => {
		test('encrypted value syncs and decrypts correctly', () => {
			const key = randomBytes(32);

			const doc1 = new Y.Doc({ guid: 'shared' });
			const doc2 = new Y.Doc({ guid: 'shared' });

			const kv1 = setupActivated<string>(doc1, 'data', new Map([[1, key]]));
			const kv2 = setupActivated<string>(doc2, 'data', new Map([[1, key]]));

			kv1.set('token', 'abc-123');
			syncDocs(doc1, doc2);

			expect(kv2.get('token')).toBe('abc-123');
			expect(isEncryptedBlob(kv2.yarray.toArray()[0]?.val)).toBe(true);
		});

		test('LWW conflict resolution works through encryption', () => {
			const key = randomBytes(32);

			const doc1 = new Y.Doc({ guid: 'shared' });
			const doc2 = new Y.Doc({ guid: 'shared' });

			const kv1 = setupActivated<string>(doc1, 'data', new Map([[1, key]]));
			const kv2 = setupActivated<string>(doc2, 'data', new Map([[1, key]]));

			kv1.yarray.push([
				{
					key: 'x',
					val: createEncryptedBlob('from-client-1-earlier', key, 'x'),
					ts: 1000,
				},
			]);
			kv2.yarray.push([
				{
					key: 'x',
					val: createEncryptedBlob('from-client-2-later', key, 'x'),
					ts: 2000,
				},
			]);

			syncBoth(doc1, doc2);

			expect(kv1.get('x')).toBe('from-client-2-later');
			expect(kv2.get('x')).toBe('from-client-2-later');
		});
	});

	describe('Key becomes available mid-session', () => {
		test('passthrough then encrypted via activateEncryption', () => {
			const { kv, yarray } = setup();

			kv.set('old-1', 'alpha');
			kv.set('old-2', 'beta');

			const key = randomBytes(32);
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
			const { kv, yarray } = setup();

			kv.set('pt-1', 'plain-a');
			kv.set('pt-2', 'plain-b');

			expect(isEncryptedBlob(yarray.toArray()[0]?.val)).toBe(false);
			expect(isEncryptedBlob(yarray.toArray()[1]?.val)).toBe(false);

			const key = randomBytes(32);
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
			const key = randomBytes(32);
			const { kv, ydoc } = setup(new Map([[1, key]]));

			let valueInBatch: string | undefined;
			ydoc.transact(() => {
				kv.set('foo', 'bar');
				valueInBatch = kv.get('foo');
			});

			expect(valueInBatch).toBe('bar');
			expect(kv.get('foo')).toBe('bar');
		});

		test('multiple sets in batch all visible via entries', () => {
			const key = randomBytes(32);
			const { kv, ydoc } = setup(new Map([[1, key]]));

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

	describe('Error containment', () => {
		test('corrupted blob does not crash observation', () => {
			const key = randomBytes(32);
			const { kv, yarray } = setup(new Map([[1, key]]));

			kv.set('good-1', 'value-1');
			kv.set('good-2', 'value-2');

			yarray.push([
				{
					key: 'corrupt',
					val: (() => {
						const blob = createEncryptedBlob('broken', key, 'corrupt');
						const tampered = new Uint8Array(blob);
						tampered[2] = (tampered[2] ?? 0) ^ 0xff;
						return tampered as EncryptedBlob;
					})(),
					ts: 10_000,
				},
			]);

			expect(kv.get('corrupt')).toBeUndefined();
			expect(kv.get('good-1')).toBe('value-1');
			expect(kv.get('good-2')).toBe('value-2');
			expect([...kv.unreadableEntries()].length).toBe(1);
		});

		test('observation continues after decrypt failure', () => {
			const key = randomBytes(32);
			const { kv, yarray } = setup(new Map([[1, key]]));

			kv.set('good', 'still-works');
			yarray.push([
				{
					key: 'corrupt',
					val: (() => {
						const blob = createEncryptedBlob('broken', key, 'corrupt');
						const tampered = new Uint8Array(blob);
						tampered[2] = (tampered[2] ?? 0) ^ 0xff;
						return tampered as EncryptedBlob;
					})(),
					ts: 10_001,
				},
			]);

			kv.set('new-good', 'appears-after-failure');

			expect(kv.get('good')).toBe('still-works');
			expect(kv.get('new-good')).toBe('appears-after-failure');
			expect(kv.get('corrupt')).toBeUndefined();
			expect([...kv.unreadableEntries()].length).toBe(1);
		});
	});

	describe('read() tri-state point read', () => {
		test('present: a readable entry reports state present with its value', () => {
			const key = randomBytes(32);
			const { kv } = setup(new Map([[1, key]]));

			kv.set('k', 'v');

			expect(kv.read('k')).toEqual({ state: 'present', val: 'v' });
		});

		test('absent: a missing key reports state absent', () => {
			const key = randomBytes(32);
			const { kv } = setup(new Map([[1, key]]));

			expect(kv.read('missing')).toEqual({ state: 'absent' });
		});

		test('unreadable: a blob whose key version is absent reports state unreadable with the reason', () => {
			const ydoc = new Y.Doc();
			const key1 = randomBytes(32);
			const key2 = randomBytes(32);
			const kv = createEncryptedYkvLww<string>(ydoc, 'data');
			// The store can only decrypt key version 2; a version-1 blob is locked out.
			kv.activateEncryption(new Map([[2, key2]]));

			const lockedBlob = createEncryptedBlob('secret', key1, 'locked');
			kv.yarray.push([{ key: 'locked', val: lockedBlob, ts: 100 }]);

			expect(kv.read('locked')).toEqual({
				state: 'unreadable',
				reason: 'keyVersion=1 not in keyring [2]',
			});
		});

		test('has() means raw existence and agrees with size across present and unreadable rows', () => {
			const ydoc = new Y.Doc();
			const key1 = randomBytes(32);
			const key2 = randomBytes(32);
			const kv = createEncryptedYkvLww<string>(ydoc, 'data');
			kv.activateEncryption(new Map([[2, key2]]));

			kv.set('readable', 'ok');
			const lockedBlob = createEncryptedBlob('secret', key1, 'locked');
			kv.yarray.push([{ key: 'locked', val: lockedBlob, ts: 100 }]);

			// has() is now raw existence: true for the readable row AND the
			// undecryptable one, so it agrees with size (which counts both).
			expect(kv.has('readable')).toBe(true);
			expect(kv.has('locked')).toBe(true);
			expect(kv.has('missing')).toBe(false);

			const existing = ['readable', 'locked', 'missing'].filter((k) =>
				kv.has(k),
			).length;
			expect(kv.size).toBe(2);
			expect(existing).toBe(kv.size);
		});
	});

	describe('Key transition (activateEncryption)', () => {
		test('key rotation upgrades old-version ciphertext to the new current version', () => {
			const key1 = randomBytes(32);
			const key2 = randomBytes(32);
			const { kv, yarray } = setup(new Map([[1, key1]]));

			kv.set('a', 'alpha');
			kv.set('b', 'beta');

			const events: Array<{ key: string; change: PlainChange<string> }> = [];
			kv.observe((changes) => {
				for (const [entryKey, change] of changes)
					events.push({ key: entryKey, change });
			});

			// Rotate from key1 to key2. v1 stays in the keyring so the walk can
			// decrypt the existing v1 blobs; after the walk, every entry is at v2.
			kv.activateEncryption(
				new Map([
					[2, key2],
					[1, key1],
				]),
			);
			expect([...kv.unreadableEntries()].length).toBe(0);
			expect(kv.get('a')).toBe('alpha');
			expect(kv.get('b')).toBe('beta');

			// At-rest blobs are now v2 (rotation upgraded them).
			for (const entry of yarray.toArray()) {
				if (!isEncryptedBlob(entry.val)) continue;
				expect(getKeyVersion(entry.val)).toBe(2);
			}

			// Re-encryption writes are filtered via REENCRYPT_ORIGIN, so
			// downstream observers see no delete/add pairs.
			const deleteEvents = events.filter(
				(event) => event.change.action === 'delete',
			);
			expect(deleteEvents.length).toBe(0);
		});

		test('activateEncryption does not emit spurious events for plaintext re-encryption', () => {
			const { kv } = setup();

			kv.set('a', 'alpha');
			kv.set('b', 'beta');

			const events: Array<{ key: string; change: PlainChange<string> }> = [];
			kv.observe((changes) => {
				for (const [entryKey, change] of changes)
					events.push({ key: entryKey, change });
			});

			// Activate encryption. Plaintext entries get encrypted under the hood.
			// but their decrypted values don't change. Should fire zero events.
			const key = randomBytes(32);
			kv.activateEncryption(new Map([[1, key]]));

			expect(events).toEqual([]);
			expect(kv.get('a')).toBe('alpha');
			expect(kv.get('b')).toBe('beta');
		});

		test('multi-version keyring upgrades all decryptable entries to the current version', () => {
			const key1 = randomBytes(32);
			const key2 = randomBytes(32);
			const { kv, yarray } = setup(new Map([[1, key1]]));
			kv.set('a', 'alpha');
			kv.set('b', 'beta');

			// Verify blobs have keyVersion 1
			for (const entry of yarray.toArray()) {
				if (isEncryptedBlob(entry.val)) {
					expect(getKeyVersion(entry.val)).toBe(1);
				}
			}

			// Activate with a two-key keyring: v2 is current, v1 is fallback.
			// The walk rewrites every v1 blob as v2. Eager rotation.
			kv.activateEncryption(
				new Map([
					[2, key2],
					[1, key1],
				]),
			);

			expect(kv.get('a')).toBe('alpha');
			expect(kv.get('b')).toBe('beta');
			expect([...kv.unreadableEntries()].length).toBe(0);

			// Every blob is now v2.
			for (const entry of yarray.toArray()) {
				if (isEncryptedBlob(entry.val)) {
					expect(getKeyVersion(entry.val)).toBe(2);
				}
			}

			// New writes get version 2.
			kv.set('c', 'gamma');
			const cEntry = yarray.toArray().find((e) => e.key === 'c');
			expect(isEncryptedBlob(cEntry?.val)).toBe(true);
			if (isEncryptedBlob(cEntry?.val)) {
				expect(getKeyVersion(cEntry.val)).toBe(2);
			}
		});
	});
});
