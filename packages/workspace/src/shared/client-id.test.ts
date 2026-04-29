import { describe, expect, test } from 'bun:test';

import { hashClientId } from './client-id.js';

describe('hashClientId', () => {
	test('is deterministic for the same input', () => {
		expect(hashClientId('/vault/scripts/import-feed.ts')).toBe(
			hashClientId('/vault/scripts/import-feed.ts'),
		);
	});

	test('produces distinct ids for distinct inputs', () => {
		expect(hashClientId('/vault/scripts/a.ts')).not.toBe(
			hashClientId('/vault/scripts/b.ts'),
		);
	});

	test('returns a positive safe integer (Yjs reserves clientID 0)', () => {
		const id = hashClientId('/some/path');
		expect(Number.isSafeInteger(id)).toBe(true);
		expect(id).toBeGreaterThan(0);
		expect(id).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
	});

	test('handles empty string without throwing', () => {
		const id = hashClientId('');
		expect(Number.isSafeInteger(id)).toBe(true);
		expect(id).toBeGreaterThan(0);
	});
});
