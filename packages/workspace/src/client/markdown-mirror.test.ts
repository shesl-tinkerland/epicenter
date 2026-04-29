/**
 * Tests for `attachMarkdownMirror` (the script-side read-only handle on the
 * daemon's markdown materializer tree). We seed a tmpdir with hand-written
 * `.md` files mirroring the daemon's layout (`<root>/<table>/<id>.md`) and
 * exercise the listing + read surface.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attachMarkdownMirror } from './markdown-mirror.js';

let rootPath: string;

beforeEach(async () => {
	rootPath = await mkdtemp(join(tmpdir(), 'markdown-mirror-'));
});

afterEach(async () => {
	await rm(rootPath, { recursive: true, force: true });
});

async function writeFixture(relativePath: string, body: string) {
	const fullPath = join(rootPath, relativePath);
	await mkdir(join(fullPath, '..'), { recursive: true });
	await writeFile(fullPath, body, 'utf-8');
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of iterable) out.push(item);
	return out;
}

describe('attachMarkdownMirror', () => {
	test('list yields one entry per .md file under the root', async () => {
		await writeFixture('entries/a.md', '# A');
		await writeFixture('entries/b.md', '# B');
		await writeFixture('notes/x.md', '# X');

		using mirror = attachMarkdownMirror({ rootPath });
		const entries = await collect(mirror.list());
		const ids = entries.map((e) => e.id).sort();
		expect(ids).toEqual(['entries/a', 'entries/b', 'notes/x']);
	});

	test('list filters by prefix', async () => {
		await writeFixture('entries/a.md', '# A');
		await writeFixture('entries/sub/c.md', '# C');
		await writeFixture('notes/x.md', '# X');

		using mirror = attachMarkdownMirror({ rootPath });
		const entries = await collect(mirror.list({ prefix: 'entries' }));
		const ids = entries.map((e) => e.id).sort();
		expect(ids).toEqual(['entries/a', 'entries/sub/c']);
	});

	test('list ignores non-markdown files', async () => {
		await writeFixture('entries/a.md', '# A');
		await writeFixture('entries/keep.txt', 'plain');
		await writeFixture('entries/.DS_Store', 'noise');

		using mirror = attachMarkdownMirror({ rootPath });
		const entries = await collect(mirror.list());
		expect(entries.map((e) => e.id)).toEqual(['entries/a']);
	});

	test('list yields nothing if the root or prefix does not exist', async () => {
		using mirror = attachMarkdownMirror({ rootPath });
		// Root exists (created by mkdtemp) but is empty.
		expect(await collect(mirror.list())).toEqual([]);
		// Missing subdirectory.
		expect(await collect(mirror.list({ prefix: 'missing' }))).toEqual([]);
	});

	test('read returns the file body for a listed id', async () => {
		await writeFixture('entries/a.md', '# Hello\n\nbody text\n');

		using mirror = attachMarkdownMirror({ rootPath });
		const entries = await collect(mirror.list());
		expect(entries.length).toBe(1);
		const body = await mirror.read(entries[0]!.id);
		expect(body).toContain('# Hello');
	});

	test('read rejects ids that traverse outside the root', async () => {
		using mirror = attachMarkdownMirror({ rootPath });
		await expect(mirror.read('../etc/passwd')).rejects.toThrow(
			/parent traversal/,
		);
	});

	test('disposed mirror yields nothing further from list', async () => {
		await writeFixture('entries/a.md', '# A');
		const mirror = attachMarkdownMirror({ rootPath });
		mirror[Symbol.dispose]();
		expect(await collect(mirror.list())).toEqual([]);
	});
});
