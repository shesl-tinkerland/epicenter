import { describe, expect, test } from 'bun:test';

import {
	appsMarkdownPath,
	markdownPath,
	sqlitePath,
	yjsPath,
} from './workspace-paths.js';

describe('document/workspace-paths', () => {
	test('yjsPath places the update log under .epicenter/yjs/', () => {
		const dir = '/Users/me/vault';
		expect(yjsPath(dir, 'epicenter-fuji')).toBe(
			'/Users/me/vault/.epicenter/yjs/epicenter-fuji.db',
		);
	});

	test('sqlitePath places the database under .epicenter/sqlite/', () => {
		const dir = '/Users/me/vault';
		expect(sqlitePath(dir, 'epicenter-fuji')).toBe(
			'/Users/me/vault/.epicenter/sqlite/epicenter-fuji.db',
		);
	});

	test('markdownPath is a directory, not a file', () => {
		const dir = '/Users/me/vault';
		expect(markdownPath(dir, 'epicenter-fuji')).toBe(
			'/Users/me/vault/.epicenter/md/epicenter-fuji',
		);
	});

	test('appsMarkdownPath is visible, keyed by mount name, outside .epicenter/', () => {
		const dir = '/Users/me/vault';
		expect(appsMarkdownPath(dir, 'fuji')).toBe('/Users/me/vault/apps/fuji');
	});
});
