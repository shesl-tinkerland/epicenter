import { describe, expect, test } from 'bun:test';
import { TRUSTED_ORIGINS } from './trusted-origins';

describe('TRUSTED_ORIGINS', () => {
	test('rejects arbitrary chrome-extension origins (no wildcard regression)', () => {
		expect(TRUSTED_ORIGINS).not.toContain('chrome-extension://attackerid');
		expect(TRUSTED_ORIGINS).not.toContain('chrome-extension://*');
		expect(TRUSTED_ORIGINS.some((o) => o.includes('*'))).toBe(false);
	});

	test('contains exactly one chrome-extension origin (the pinned tab-manager)', () => {
		const exts = TRUSTED_ORIGINS.filter((o) =>
			o.startsWith('chrome-extension://'),
		);
		expect(exts).toEqual([
			'chrome-extension://mkbnicfhpacdofmoocppnjjmdfmkkgda',
		]);
	});

	test('is frozen so Cloudflare isolates cannot accumulate mutations', () => {
		expect(Object.isFrozen(TRUSTED_ORIGINS)).toBe(true);
	});

	test('does not contain duplicate entries', () => {
		expect(TRUSTED_ORIGINS.length).toBe(new Set(TRUSTED_ORIGINS).size);
	});

	test('does not contain plaintext http origins', () => {
		expect(TRUSTED_ORIGINS.every((o) => !o.startsWith('http://'))).toBe(true);
	});

	test('does not contain localhost (dev frontends target the local API directly)', () => {
		expect(
			TRUSTED_ORIGINS.every(
				(o) => !o.includes('localhost') || o === 'tauri://localhost',
			),
		).toBe(true);
	});

	test('every entry is one of: https, tauri://localhost, chrome-extension://', () => {
		for (const origin of TRUSTED_ORIGINS) {
			const isAllowedShape =
				origin.startsWith('https://') ||
				origin === 'tauri://localhost' ||
				origin.startsWith('chrome-extension://');
			expect(isAllowedShape).toBe(true);
		}
	});

	test('includes the canonical API origin', () => {
		expect(TRUSTED_ORIGINS).toContain('https://api.epicenter.so');
	});
});
