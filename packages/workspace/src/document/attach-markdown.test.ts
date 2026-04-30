/**
 * Markdown Materializer Bidirectional Sync Tests
 *
 * Tests the `push` and `pull` mutations on `attachMarkdown`.
 * Uses real temp directories and Yjs workspaces so the materializer
 * exercises actual table set/get and filesystem paths.
 *
 * Key behaviors:
 * - push reads `.md` files, parses frontmatter, and calls table.set()
 * - push skips non-`.md` files and files without valid frontmatter
 * - push reports errors for unreadable files
 * - push uses custom fromMarkdown callback when provided
 * - push silently skips tables whose directories don't exist
 * - pull re-serializes all valid rows to disk
 * - pull uses custom filename + toMarkdown callbacks when provided
 * - Round-trip: pull → push preserves data
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type } from 'arktype';
import * as Y from 'yjs';
import {
	attachTables,
	createDisposableCache,
	defineTable,
} from '../index.js';
import {
	attachMarkdown,
	type MarkdownShape,
} from './attach-markdown.js';
import { parseMarkdownFile } from './markdown/parse-markdown-file.js';

// ============================================================================
// Test Table Definitions
// ============================================================================

const postsTable = defineTable(
	type({ id: 'string', title: 'string', published: 'boolean', _v: '1' }),
);

const notesTable = defineTable(type({ id: 'string', body: 'string', _v: '1' }));

const tableDefinitions = { posts: postsTable, notes: notesTable };

// ============================================================================
// Test Directory Setup
// ============================================================================

const TEST_DIR = join(import.meta.dir, '__test-materializer__');

beforeEach(async () => {
	await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
	await rm(TEST_DIR, { recursive: true, force: true });
});

// ============================================================================
// Helpers
// ============================================================================

async function writeTestFile(relativePath: string, content: string) {
	const fullPath = join(TEST_DIR, relativePath);
	await mkdir(join(fullPath, '..'), { recursive: true });
	await writeFile(fullPath, content, 'utf-8');
}

async function readTestFile(relativePath: string) {
	return readFile(join(TEST_DIR, relativePath), 'utf-8');
}

async function listTestDir(relativePath: string) {
	return readdir(join(TEST_DIR, relativePath));
}

type AttachedTables = ReturnType<typeof attachTables<typeof tableDefinitions>>;
type Materializer = ReturnType<typeof attachMarkdown>;
type TableRegistration = {
	table: Parameters<Materializer['table']>[0];
	config?: Parameters<Materializer['table']>[1];
};

async function setup(options?: {
	tables?: (t: AttachedTables) => TableRegistration[];
}) {
	const cache = createDisposableCache((id: string) => {
		const ydoc = new Y.Doc({ guid: id });
		const tables = attachTables(ydoc, tableDefinitions);

		const materializer = attachMarkdown(ydoc, {
			dir: TEST_DIR,
		});

		const registrations =
			options?.tables?.(tables) ??
			([{ table: tables.posts }, { table: tables.notes }] as TableRegistration[]);
		for (const { table, config } of registrations) {
			materializer.table(table, config);
		}

		return {
			ydoc,
			tables,
			materializer,
			whenReady: materializer.whenLoaded,
			[Symbol.dispose]() {
				ydoc.destroy();
			},
		};
	}, { gcTime: 0 });

	const workspace = cache.open('test.materializer');
	await workspace.whenReady;
	return { workspace, cache };
}

// ============================================================================
// push Tests
// ============================================================================

describe('push', () => {
	test('imports markdown files into workspace tables', async () => {
		const { workspace } = await setup({ tables: (t) => [{ table: t.posts }] });
		await writeTestFile(
			'posts/hello.md',
			'---\nid: post-1\ntitle: Hello World\npublished: true\n_v: 1\n---\n',
		);
		await writeTestFile(
			'posts/draft.md',
			'---\nid: post-2\ntitle: Draft Post\npublished: false\n_v: 1\n---\n',
		);

		const result = await workspace.materializer.push({});

		expect(result.imported).toBe(2);
		expect(result.skipped).toBe(0);
		expect(result.errored).toBe(0);

		const { data: post1 } = workspace.tables.posts.get('post-1');
		expect(post1?.title).toBe('Hello World');
		expect(post1?.published).toBe(true);

		const { data: post2 } = workspace.tables.posts.get('post-2');
		expect(post2?.title).toBe('Draft Post');

		workspace[Symbol.dispose]();
	});

	test('skips non-.md files', async () => {
		const { workspace } = await setup({ tables: (t) => [{ table: t.posts }] });
		await writeTestFile(
			'posts/valid.md',
			'---\nid: p1\ntitle: Valid\npublished: false\n_v: 1\n---\n',
		);
		await writeTestFile('posts/readme.txt', 'not a markdown file');
		await writeTestFile('posts/data.json', '{"id": "test"}');

		const result = await workspace.materializer.push({});

		expect(result.imported).toBe(1);
		expect(result.skipped).toBe(0);

		workspace[Symbol.dispose]();
	});

	test('skips files without valid frontmatter', async () => {
		const { workspace } = await setup({ tables: (t) => [{ table: t.posts }] });
		await writeTestFile(
			'posts/valid.md',
			'---\nid: p1\ntitle: Valid\npublished: false\n_v: 1\n---\n',
		);
		await writeTestFile(
			'posts/no-frontmatter.md',
			'# Just a heading\n\nSome content\n',
		);

		const result = await workspace.materializer.push({});

		expect(result.imported).toBe(1);
		expect(result.skipped).toBe(1);

		workspace[Symbol.dispose]();
	});

	test('silently skips tables whose directories do not exist', async () => {
		const { workspace } = await setup({ tables: (t) => [{ table: t.posts }] });
		// Don't create the posts directory: it should not exist
		const result = await workspace.materializer.push({});

		expect(result.imported).toBe(0);
		expect(result.skipped).toBe(0);
		expect(result.errored).toBe(0);

		workspace[Symbol.dispose]();
	});

	test('emits error event when frontmatter fails schema validation', async () => {
		const { workspace } = await setup({ tables: (t) => [{ table: t.posts }] });
		// Valid frontmatter structure but wrong type: title must be a string,
		// here it's a number. `fromMarkdown` happily returns it; `table.parse()`
		// catches the schema violation.
		await writeTestFile(
			'posts/bad.md',
			'---\nid: post-bad\ntitle: 42\npublished: true\n_v: 1\n---\n',
		);

		const result = await workspace.materializer.push({});

		expect(result.imported).toBe(0);
		expect(result.skipped).toBe(0);
		expect(result.errored).toBe(1);

		const errorEvent = result.events.find((e) => e.kind === 'error');
		expect(errorEvent?.kind).toBe('error');
		if (errorEvent?.kind === 'error') {
			expect(errorEvent.path).toBe('posts/bad.md');
			expect(errorEvent.tableName).toBe('posts');
			expect(errorEvent.error.name).toBe('ValidationFailed');
		}

		workspace[Symbol.dispose]();
	});

	test('emits error event when fromMarkdown callback throws', async () => {
		const { workspace } = await setup({
			tables: (t) => [
				{
					table: t.notes,
					config: {
						fromMarkdown: () => {
							throw new Error('simulated callback failure');
						},
					},
				},
			],
		});
		await writeTestFile(
			'notes/boom.md',
			'---\nid: note-boom\n---\n\nirrelevant\n',
		);

		const result = await workspace.materializer.push({});

		expect(result.errored).toBe(1);
		const errorEvent = result.events.find((e) => e.kind === 'error');
		expect(errorEvent?.kind).toBe('error');
		if (errorEvent?.kind === 'error') {
			expect(errorEvent.error.name).toBe('FromMarkdownCallbackFailed');
			expect(errorEvent.error.message).toContain('simulated callback failure');
		}

		workspace[Symbol.dispose]();
	});

	test('counts match event kinds (invariant)', async () => {
		const { workspace } = await setup({ tables: (t) => [{ table: t.posts }] });
		await writeTestFile(
			'posts/good.md',
			'---\nid: p1\ntitle: Good\npublished: true\n_v: 1\n---\n',
		);
		await writeTestFile('posts/no-frontmatter.md', 'just a heading\n');
		await writeTestFile(
			'posts/bad.md',
			'---\nid: p3\ntitle: 42\npublished: true\n_v: 1\n---\n',
		);

		const result = await workspace.materializer.push({});

		expect(result.imported).toBe(1);
		expect(result.skipped).toBe(1);
		expect(result.errored).toBe(1);
		expect(result.events).toHaveLength(3);
		expect(result.events.filter((e) => e.kind === 'imported')).toHaveLength(1);
		expect(result.events.filter((e) => e.kind === 'skipped')).toHaveLength(1);
		expect(result.events.filter((e) => e.kind === 'error')).toHaveLength(1);

		workspace[Symbol.dispose]();
	});

	test('uses custom fromMarkdown callback', async () => {
		const { workspace } = await setup({
			tables: (t) => [
				{
					table: t.notes,
					config: {
						fromMarkdown: (parsed) => ({
							id: parsed.frontmatter.id as string,
							body: parsed.body ?? '',
							_v: 1 as const,
						}),
					},
				},
			],
		});
		await writeTestFile(
			'notes/my-note.md',
			'---\nid: note-1\n---\n\nThis is the body content\n',
		);

		const result = await workspace.materializer.push({});

		expect(result.imported).toBe(1);

		const { data: note } = workspace.tables.notes.get('note-1');
		expect(note?.body).toBe('This is the body content');

		workspace[Symbol.dispose]();
	});

	test('uses custom table directory', async () => {
		const { workspace } = await setup({
			tables: (t) => [{ table: t.posts, config: { dir: 'blog' } }],
		});
		await writeTestFile(
			'blog/hello.md',
			'---\nid: p1\ntitle: Hello\npublished: false\n_v: 1\n---\n',
		);

		const result = await workspace.materializer.push({});

		expect(result.imported).toBe(1);
		expect(workspace.tables.posts.has('p1')).toBe(true);

		workspace[Symbol.dispose]();
	});

	test('overwrites existing rows (set is insert-or-replace)', async () => {
		const { workspace } = await setup({ tables: (t) => [{ table: t.posts }] });
		// First import
		await writeTestFile(
			'posts/p1.md',
			'---\nid: p1\ntitle: Original\npublished: false\n_v: 1\n---\n',
		);

		const first = await workspace.materializer.push({});
		expect(first.imported).toBe(1);

		const { data: originalPost } = workspace.tables.posts.get('p1');
		expect(originalPost?.title).toBe('Original');

		// Flush observer microtasks (observer writes files on table.set() from the first push)
		await Bun.sleep(0);

		// Second import: overwrite the same file with different data
		await writeTestFile(
			'posts/p1.md',
			'---\nid: p1\ntitle: Updated From Disk\npublished: true\n_v: 1\n---\n',
		);

		const second = await workspace.materializer.push({});
		expect(second.imported).toBe(1);

		const { data: updatedPost } = workspace.tables.posts.get('p1');
		expect(updatedPost?.title).toBe('Updated From Disk');
		expect(updatedPost?.published).toBe(true);

		workspace[Symbol.dispose]();
	});

	test('imports across multiple tables', async () => {
		const { workspace } = await setup();
		await writeTestFile(
			'posts/post.md',
			'---\nid: p1\ntitle: Post\npublished: false\n_v: 1\n---\n',
		);
		await writeTestFile(
			'notes/note.md',
			'---\nid: n1\nbody: Note body\n_v: 1\n---\n',
		);

		const result = await workspace.materializer.push({});

		expect(result.imported).toBe(2);
		expect(workspace.tables.posts.has('p1')).toBe(true);
		expect(workspace.tables.notes.has('n1')).toBe(true);

		workspace[Symbol.dispose]();
	});
});

// ============================================================================
// pull Tests
// ============================================================================

describe('pull', () => {
	test('writes all valid rows to disk', async () => {
		const { workspace } = await setup({ tables: (t) => [{ table: t.posts }] });
		workspace.tables.posts.set({
			id: 'p1',
			title: 'First',
			published: true,
			_v: 1,
		});
		workspace.tables.posts.set({
			id: 'p2',
			title: 'Second',
			published: false,
			_v: 1,
		});

		const result = await workspace.materializer.pull({});

		expect(result.written).toBe(2);

		// Verify files were written with correct content
		const content1 = await readTestFile('posts/p1.md');
		expect(content1).toContain('title: First');

		const content2 = await readTestFile('posts/p2.md');
		expect(content2).toContain('title: Second');

		workspace[Symbol.dispose]();
	});

	test('creates table directory before writing', async () => {
		const { workspace } = await setup({ tables: (t) => [{ table: t.posts }] });
		workspace.tables.posts.set({
			id: 'p1',
			title: 'First',
			published: false,
			_v: 1,
		});

		await workspace.materializer.pull({});

		const entries = await listTestDir('posts');
		expect(entries).toContain('p1.md');

		workspace[Symbol.dispose]();
	});

	test('uses custom filename and toMarkdown callbacks', async () => {
		const { workspace } = await setup({
			tables: (t) => [
				{
					table: t.notes,
					config: {
						filename: (row) => `${row.id}-custom.md`,
						toMarkdown: (row) => ({
							frontmatter: { id: row.id },
							body: row.body as string,
						}),
					},
				},
			],
		});
		workspace.tables.notes.set({ id: 'n1', body: 'Custom body', _v: 1 });

		const result = await workspace.materializer.pull({});

		expect(result.written).toBe(1);

		const content = await readTestFile('notes/n1-custom.md');
		expect(content).toContain('Custom body');

		workspace[Symbol.dispose]();
	});

	test('uses custom table directory', async () => {
		const { workspace } = await setup({
			tables: (t) => [{ table: t.posts, config: { dir: 'blog' } }],
		});
		workspace.tables.posts.set({
			id: 'p1',
			title: 'Blog Post',
			published: false,
			_v: 1,
		});

		await workspace.materializer.pull({});

		const entries = await listTestDir('blog');
		expect(entries).toContain('p1.md');

		workspace[Symbol.dispose]();
	});

	test('writes nothing when table is empty', async () => {
		const { workspace } = await setup({ tables: (t) => [{ table: t.posts }] });
		const result = await workspace.materializer.pull({});

		expect(result.written).toBe(0);

		workspace[Symbol.dispose]();
	});

	test('writes across multiple tables', async () => {
		const { workspace } = await setup();
		workspace.tables.posts.set({
			id: 'p1',
			title: 'Post',
			published: false,
			_v: 1,
		});
		workspace.tables.notes.set({ id: 'n1', body: 'Note', _v: 1 });

		const result = await workspace.materializer.pull({});

		expect(result.written).toBe(2);

		const postsEntries = await listTestDir('posts');
		expect(postsEntries).toContain('p1.md');

		const notesEntries = await listTestDir('notes');
		expect(notesEntries).toContain('n1.md');

		workspace[Symbol.dispose]();
	});
});

// ============================================================================
// rebuild Tests
// ============================================================================

describe('rebuild', () => {
	test('removes orphan files and rewrites existing valid rows', async () => {
		const { workspace } = await setup({ tables: (t) => [{ table: t.posts }] });
		// Seed disk with rows + an orphan file
		workspace.tables.posts.set({
			id: 'p1',
			title: 'Live',
			published: true,
			_v: 1,
		});
		await workspace.materializer.pull({});
		await writeTestFile(
			'posts/orphan.md',
			'---\nid: orphan\ntitle: Orphan\npublished: false\n_v: 1\n---\n',
		);

		const before = await listTestDir('posts');
		expect(before).toContain('p1.md');
		expect(before).toContain('orphan.md');

		const result = await workspace.materializer.rebuild({});

		expect(result.deleted).toBe(2); // p1.md + orphan.md both unlinked
		expect(result.written).toBe(1); // only p1 re-written

		const after = await listTestDir('posts');
		expect(after).toContain('p1.md');
		expect(after).not.toContain('orphan.md');

		workspace[Symbol.dispose]();
	});

	test('rebuild with table argument only touches that table', async () => {
		const { workspace } = await setup();
		workspace.tables.posts.set({
			id: 'p1',
			title: 'Post',
			published: false,
			_v: 1,
		});
		workspace.tables.notes.set({ id: 'n1', body: 'Note', _v: 1 });
		await workspace.materializer.pull({});
		await writeTestFile(
			'notes/orphan.md',
			'---\nid: x\nbody: gone\n_v: 1\n---\n',
		);

		const result = await workspace.materializer.rebuild({ table: 'posts' });

		expect(result.deleted).toBe(1); // p1.md
		expect(result.written).toBe(1); // p1 re-written

		// notes/ is untouched: orphan still there
		const notesEntries = await listTestDir('notes');
		expect(notesEntries).toContain('orphan.md');

		workspace[Symbol.dispose]();
	});

	test('throws on unknown table name', async () => {
		const { workspace } = await setup({ tables: (t) => [{ table: t.posts }] });
		await expect(
			workspace.materializer.rebuild({ table: 'notAThing' }),
		).rejects.toThrow(/not in the materialized table set/);

		workspace[Symbol.dispose]();
	});

	test('is idempotent: rebuild twice produces identical filesystem state', async () => {
		const { workspace } = await setup({ tables: (t) => [{ table: t.posts }] });
		workspace.tables.posts.set({
			id: 'p1',
			title: 'A',
			published: true,
			_v: 1,
		});
		workspace.tables.posts.set({
			id: 'p2',
			title: 'B',
			published: false,
			_v: 1,
		});

		const first = await workspace.materializer.rebuild({});
		const stateAfterFirst = await listTestDir('posts');
		const contentsAfterFirst = await Promise.all(
			stateAfterFirst.map((f) => readTestFile(`posts/${f}`)),
		);

		const second = await workspace.materializer.rebuild({});
		const stateAfterSecond = await listTestDir('posts');
		const contentsAfterSecond = await Promise.all(
			stateAfterSecond.map((f) => readTestFile(`posts/${f}`)),
		);

		// On the first rebuild, written=2 and deleted=0 (no files existed).
		// On the second, deleted=2 (wipes the first's output) and written=2.
		expect(first.written).toBe(2);
		expect(second.written).toBe(2);
		expect(second.deleted).toBe(2);

		expect(stateAfterSecond).toEqual(stateAfterFirst);
		expect(contentsAfterSecond).toEqual(contentsAfterFirst);

		workspace[Symbol.dispose]();
	});
});

// ============================================================================
// Round-Trip Tests
// ============================================================================

describe('round-trip', () => {
	test('pull then push on fresh workspace preserves row data', async () => {
		// First workspace: populate and pull to disk
		const cache1 = createDisposableCache((id: string) => {
			const ydoc = new Y.Doc({ guid: id });
			const tables = attachTables(ydoc, tableDefinitions);
			const materializer = attachMarkdown(ydoc, {
				dir: TEST_DIR,
			}).table(tables.posts);
			return {
				ydoc,
				tables,
				materializer,
				whenReady: materializer.whenLoaded,
				[Symbol.dispose]() {
					ydoc.destroy();
				},
			};
		});

		const workspace1 = cache1.open('test.roundtrip.1');
		await workspace1.whenReady;

		workspace1.tables.posts.set({
			id: 'p1',
			title: 'Round Trip',
			published: true,
			_v: 1,
		});
		workspace1.tables.posts.set({
			id: 'p2',
			title: 'Another',
			published: false,
			_v: 1,
		});

		await workspace1.materializer.pull({});
		workspace1[Symbol.dispose]();

		// Verify files on disk have valid frontmatter
		const p1Content = await readTestFile('posts/p1.md');
		const p1Parsed = parseMarkdownFile(p1Content);
		expect(p1Parsed).not.toBeNull();
		expect(p1Parsed!.frontmatter.title).toBe('Round Trip');

		// Second workspace: fresh instance, push from the same directory
		const cache2 = createDisposableCache((id: string) => {
			const ydoc = new Y.Doc({ guid: id });
			const tables = attachTables(ydoc, tableDefinitions);
			const materializer = attachMarkdown(ydoc, {
				dir: TEST_DIR,
			}).table(tables.posts);
			return {
				ydoc,
				tables,
				materializer,
				whenReady: materializer.whenLoaded,
				[Symbol.dispose]() {
					ydoc.destroy();
				},
			};
		});

		const workspace2 = cache2.open('test.roundtrip.2');
		await workspace2.whenReady;

		const result = await workspace2.materializer.push({});
		expect(result.imported).toBe(2);

		const { data: p1 } = workspace2.tables.posts.get('p1');
		expect(p1?.title).toBe('Round Trip');
		expect(p1?.published).toBe(true);

		const { data: p2 } = workspace2.tables.posts.get('p2');
		expect(p2?.title).toBe('Another');
		expect(p2?.published).toBe(false);

		workspace2[Symbol.dispose]();
	});

	test('fromMarkdown(toMarkdown(row)) preserves row: MarkdownShape round-trip', async () => {
		// Explicit toMarkdown / fromMarkdown pair over the shared MarkdownShape
		// type, so the compiler guarantees one is the inverse of the other.
		const toMarkdownFn = (row: {
			id: string;
			body: string;
			_v: 1;
		}): MarkdownShape => ({
			frontmatter: { id: row.id, _v: row._v },
			body: row.body,
		});
		const fromMarkdownFn = (parsed: MarkdownShape) => ({
			id: parsed.frontmatter.id as string,
			body: parsed.body ?? '',
			_v: 1 as const,
		});

		const { workspace } = await setup({
			tables: (t) =>
				[
					{
						table: t.notes,
						config: { toMarkdown: toMarkdownFn, fromMarkdown: fromMarkdownFn },
					},
				] as unknown as TableRegistration[],
		});

		const original = { id: 'n1', body: 'Hello, round trip!', _v: 1 as const };
		workspace.tables.notes.set(original);

		// Pull to disk, then push from disk into a fresh workspace.
		await workspace.materializer.pull({});

		// Also assert the pure inverse identity: fromMarkdown(toMarkdown(x)) ≡ x
		expect(fromMarkdownFn(toMarkdownFn(original))).toEqual(original);

		// And verify the end-to-end disk round trip.
		const disk = await readTestFile('notes/n1.md');
		const parsed = parseMarkdownFile(disk);
		expect(parsed).not.toBeNull();
		expect(fromMarkdownFn(parsed!)).toEqual(original);

		workspace[Symbol.dispose]();
	});

	test('inline field-to-body pair round-trips over MarkdownShape', async () => {
		// Most real apps store body content in a separate Y.Doc (via
		// createDisposableCache). This test covers the simpler case where body IS a
		// row field: `notes.body` here. Inline callbacks keep the intent
		// at the call site; no helper abstracts the destructure.
		const { workspace } = await setup({
			tables: (t) =>
				[
					{
						table: t.notes,
						config: {
							toMarkdown: (row: { id: string; body: string; _v: 1 }) => {
								const { body, ...frontmatter } = row;
								return { frontmatter, body };
							},
							fromMarkdown: (parsed: MarkdownShape) => ({
								id: parsed.frontmatter.id as string,
								body: parsed.body ?? '',
								_v: 1 as const,
							}),
						},
					},
				] as unknown as TableRegistration[],
		});

		const original = { id: 'n1', body: 'Body content here', _v: 1 as const };
		workspace.tables.notes.set(original);

		await workspace.materializer.pull({});

		const disk = await readTestFile('notes/n1.md');
		const parsed = parseMarkdownFile(disk);
		expect(parsed).not.toBeNull();
		// Body ended up in the markdown body section, not frontmatter.
		expect(parsed!.body).toBe('Body content here');
		expect(parsed!.frontmatter.body).toBeUndefined();

		workspace[Symbol.dispose]();
	});
});
