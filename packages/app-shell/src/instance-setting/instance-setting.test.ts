/**
 * Tests for the shared instance setting factory. Bun has no `localStorage`, so a
 * tiny in-memory shim stands in; the assertions pin the behavior the per-app
 * copies used to carry: default-on-missing/corrupt, normalize + token-trim on
 * read, write/clear roundtrip, and isolation between two apps' keys.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createInstanceSetting } from './instance-setting.js';

class MemStorage {
	private m = new Map<string, string>();
	getItem(k: string) {
		return this.m.has(k) ? (this.m.get(k) as string) : null;
	}
	setItem(k: string, v: string) {
		this.m.set(k, String(v));
	}
	removeItem(k: string) {
		this.m.delete(k);
	}
	clear() {
		this.m.clear();
	}
}

beforeEach(() => {
	(globalThis as { localStorage?: unknown }).localStorage = new MemStorage();
});
afterEach(() => {
	(globalThis as { localStorage?: unknown }).localStorage = undefined;
});

const DEFAULT = 'https://api.epicenter.so';
const make = (storageKey: string) =>
	createInstanceSetting({ storageKey, defaultBaseURL: DEFAULT });

describe('createInstanceSetting', () => {
	test('a missing record reads as the hosted default', () => {
		const s = make('fuji.instance');
		expect(s.readInstance()).toEqual({ baseURL: DEFAULT });
		expect(s.isDefaultInstance(s.readInstance())).toBe(true);
	});

	test('write then read roundtrips a self-host instance with a token', () => {
		const s = make('fuji.instance');
		s.writeInstance({ baseURL: 'https://my.box', token: 'tok-1' });
		expect(s.readInstance()).toEqual({
			baseURL: 'https://my.box',
			token: 'tok-1',
		});
		expect(s.isDefaultInstance(s.readInstance())).toBe(false);
	});

	test('normalizes the base URL on read and trims an empty token to undefined', () => {
		localStorage.setItem(
			'fuji.instance',
			JSON.stringify({ baseURL: 'my.box/', token: '   ' }),
		);
		const s = make('fuji.instance');
		expect(s.readInstance()).toEqual({
			baseURL: 'https://my.box',
			token: undefined,
		});
	});

	test('a corrupt record falls back to the default instead of throwing', () => {
		localStorage.setItem('fuji.instance', '{not json');
		expect(make('fuji.instance').readInstance()).toEqual({ baseURL: DEFAULT });
	});

	test('clear reverts to the default', () => {
		const s = make('fuji.instance');
		s.writeInstance({ baseURL: 'https://my.box', token: 't' });
		s.clearInstance();
		expect(s.readInstance()).toEqual({ baseURL: DEFAULT });
	});

	test('two apps with different keys are isolated', () => {
		const fuji = make('fuji.instance');
		const vocab = make('vocab.instance');
		fuji.writeInstance({ baseURL: 'https://fuji.box', token: 'f' });
		expect(vocab.readInstance()).toEqual({ baseURL: DEFAULT });
		expect(fuji.readInstance()).toEqual({
			baseURL: 'https://fuji.box',
			token: 'f',
		});
	});
});
