import { describe, expect, it } from 'bun:test';
import {
	type AsyncStorage,
	asNodeId,
	createNodeId,
	createNodeIdAsync,
	type SimpleStorage,
} from './node-id.js';

function makeMemoryStorage(
	initial: Record<string, string> = {},
): SimpleStorage {
	const store = new Map(Object.entries(initial));
	return {
		getItem: (k) => store.get(k) ?? null,
		setItem: (k, v) => {
			store.set(k, v);
		},
	};
}

function makeAsyncMemoryStorage(
	initial: Record<string, string> = {},
): AsyncStorage {
	const store = new Map(Object.entries(initial));
	return {
		getItem: async (k) => store.get(k) ?? null,
		setItem: async (k, v) => {
			store.set(k, v);
		},
	};
}

describe('createNodeId', () => {
	it('returns the existing value when storage already holds one', () => {
		const storage = makeMemoryStorage({
			'epicenter.node.id': 'preexisting-id',
		});
		expect(createNodeId({ storage })).toBe(asNodeId('preexisting-id'));
	});

	it('generates and persists when storage is empty', () => {
		const storage = makeMemoryStorage();
		const fresh = createNodeId({ storage });
		expect(fresh).toMatch(/^[a-z0-9]{16}$/);
		expect(storage.getItem('epicenter.node.id')).toBe(fresh);
	});

	it('returns the same value on subsequent calls (idempotent)', () => {
		const storage = makeMemoryStorage();
		const first = createNodeId({ storage });
		const second = createNodeId({ storage });
		expect(second).toBe(first);
	});

	it('does not collide on independent storages', () => {
		const a = createNodeId({ storage: makeMemoryStorage() });
		const b = createNodeId({ storage: makeMemoryStorage() });
		expect(a).not.toBe(b);
	});
});

describe('createNodeIdAsync', () => {
	it('returns the existing value when storage already holds one', async () => {
		const storage = makeAsyncMemoryStorage({
			'epicenter.node.id': 'preexisting-id',
		});
		expect(await createNodeIdAsync({ storage })).toBe(
			asNodeId('preexisting-id'),
		);
	});

	it('generates and persists when storage is empty', async () => {
		const storage = makeAsyncMemoryStorage();
		const fresh = await createNodeIdAsync({ storage });
		expect(fresh).toMatch(/^[a-z0-9]{16}$/);
		expect(await storage.getItem('epicenter.node.id')).toBe(fresh);
	});

	it('returns the same value on subsequent calls (idempotent)', async () => {
		const storage = makeAsyncMemoryStorage();
		const first = await createNodeIdAsync({ storage });
		const second = await createNodeIdAsync({ storage });
		expect(second).toBe(first);
	});
});
