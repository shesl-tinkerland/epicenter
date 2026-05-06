import { describe, expect, it } from 'bun:test';
import { getOrCreateInstallationId, type SimpleStorage } from './device-id.js';

function makeMemoryStorage(initial: Record<string, string> = {}): SimpleStorage {
	const store = new Map(Object.entries(initial));
	return {
		getItem: (k) => store.get(k) ?? null,
		setItem: (k, v) => {
			store.set(k, v);
		},
	};
}

describe('getOrCreateInstallationId', () => {
	it('returns the existing value when storage already holds one', () => {
		const storage = makeMemoryStorage({
			'epicenter:installationId': 'preexisting-id',
		});
		expect(getOrCreateInstallationId(storage)).toBe('preexisting-id');
	});

	it('generates and persists when storage is empty', () => {
		const storage = makeMemoryStorage();
		const fresh = getOrCreateInstallationId(storage);
		expect(fresh).toMatch(/^[a-z0-9]{15}$/);
		expect(storage.getItem('epicenter:installationId')).toBe(fresh);
	});

	it('returns the same value on subsequent calls (idempotent)', () => {
		const storage = makeMemoryStorage();
		const first = getOrCreateInstallationId(storage);
		const second = getOrCreateInstallationId(storage);
		expect(second).toBe(first);
	});

	it('does not collide on independent storages', () => {
		const a = getOrCreateInstallationId(makeMemoryStorage());
		const b = getOrCreateInstallationId(makeMemoryStorage());
		expect(a).not.toBe(b);
	});
});
