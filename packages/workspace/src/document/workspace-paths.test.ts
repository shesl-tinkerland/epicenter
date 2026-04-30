import { describe, expect, test } from 'bun:test';

import { markdownPath, sqlitePath, yjsPath } from './workspace-paths.js';

describe('document/workspace-paths', () => {
	test('yjsPath places the update log under .epicenter/yjs/', () => {
		const dir = '/Users/me/vault';
		expect(yjsPath(dir, 'epicenter.fuji')).toBe(
			'/Users/me/vault/.epicenter/yjs/epicenter.fuji.db',
		);
	});

	test('sqlitePath lives alongside yjsPath under .epicenter/', () => {
		const dir = '/Users/me/vault';
		expect(sqlitePath(dir, 'epicenter.fuji')).toBe(
			'/Users/me/vault/.epicenter/sqlite/epicenter.fuji.db',
		);
		// Distinct from the yjs file (raw update log) so the two coexist
		// without colliding.
		expect(sqlitePath(dir, 'epicenter.fuji')).not.toBe(
			yjsPath(dir, 'epicenter.fuji'),
		);
	});

	test('markdownPath is a directory, not a file', () => {
		const dir = '/Users/me/vault';
		expect(markdownPath(dir, 'epicenter.fuji')).toBe(
			'/Users/me/vault/.epicenter/md/epicenter.fuji',
		);
	});
});
