/**
 * The wiki pages-and-tags model, end to end. The first test walks the spec's
 * example page: define structured tags at runtime, create a page that wears a
 * mix of plain and structured tags (auto-minting an unknown one), materialize
 * it one-way to `pages/<id>.md`, write through an action, project to SQLite, and
 * answer the typed JOIN. Focused tests cover the schema-on-read lens, the
 * rename-vs-add DDL distinction, plain-tag membership, the two edge provenances,
 * and auto-mint.
 *
 * If this loop holds, the Entity-Component architecture is real.
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { column } from '@epicenter/workspace';
import { createWiki } from './index';
import { viewThroughTag } from './lens';
import { attachWikiVault } from './markdown';
import { projectWiki } from './projection';
import type { ColumnSpec } from './schema';

const youtubeColumns: ColumnSpec[] = [
	{ id: 'url', name: 'URL', schema: column.url() },
	{
		id: 'duration',
		name: 'Duration',
		schema: column.nullable(column.number()),
	},
];

/** Define the structured tags the spec's example page wears. */
function defineExampleTags(wiki: ReturnType<typeof createWiki>): void {
	wiki.actions.tags_define({
		id: 'youtube_video',
		name: 'YouTube Video',
		columns: youtubeColumns,
	});
	wiki.actions.tags_define({
		id: 'publishable',
		name: 'Publishable',
		columns: [{ id: 'stage', name: 'Stage', schema: column.string() }],
	});
	wiki.actions.tags_define({
		id: 'whispering_recording',
		name: 'Whispering Recording',
		columns: [{ id: 'recording', name: 'Recording', schema: column.string() }],
		description: 'A page captured from a [[whispering]] recording.',
	});
}

test('materializes the spec example page one-way, writes through an action, answers the typed JOIN, and builds both edge kinds', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'wiki-vault-'));
	const wiki = createWiki();
	try {
		defineExampleTags(wiki);

		// Create the example page. `idea` is never defined: it auto-mints as a
		// bare plain tag. The recording is an `epicenter://` URN to a cross-app
		// source (a plain string column; the projector reads the edge by value).
		const created = wiki.actions.pages_create({
			title: 'Great talk',
			tags: {
				idea: {},
				youtube_video: { url: 'https://youtu.be/abc', duration: 1240 },
				publishable: { stage: 'draft' },
				whispering_recording: {
					recording: 'epicenter://whispering/recordings/rec_123',
				},
			},
			body: 'Notes about the talk. See also [[page_def]].',
		});
		const pageId = created.id;

		// Auto-mint: the unknown `idea` tag now exists as a bare plain definition.
		const idea = wiki.actions.tags_get_all().find((t) => t.id === 'idea');
		expect(idea).toBeDefined();
		expect(idea!.columns).toEqual([]);
		expect(idea!.description).toBeNull();

		// Materialize through the vault.
		const vault = attachWikiVault(wiki, { dir });
		await vault.whenFlushed;

		const pagePath = join(dir, 'pages', `${pageId}.md`);
		const pageMd = await readFile(pagePath, 'utf-8');
		expect(pageMd).toContain('https://youtu.be/abc');
		expect(pageMd).toContain('duration: 1240');
		expect(pageMd).toContain('Notes about the talk.');
		expect(pageMd).toContain('[[page_def]]');
		expect(pageMd).toContain('epicenter://whispering/recordings/rec_123');

		// tags/<id>.md carries the column schema as JSON, plus the description.
		const tagMd = await readFile(
			join(dir, 'tags', 'youtube_video.md'),
			'utf-8',
		);
		expect(tagMd).toContain('format: uri'); // column.url()
		const recordingTagMd = await readFile(
			join(dir, 'tags', 'whispering_recording.md'),
			'utf-8',
		);
		// The recording column is a plain string (no schema marker); references are
		// recognized from the `epicenter://` URN value, not the schema.
		expect(recordingTagMd).toContain('captured from a [[whispering]]');

		// Writes go through actions, never by editing the .md (the vault is a
		// one-way read projection). Re-wearing the tag overwrites its values.
		const reassigned = wiki.actions.pages_assign_tag({
			id: pageId,
			tagId: 'youtube_video',
			values: { url: 'https://youtu.be/abc', duration: 999 },
		});
		expect(reassigned.data!.tags.youtube_video!.duration).toBe(999);

		// Project to SQLite and answer the typed JOIN (bare column names).
		const db = new Database(':memory:');
		try {
			projectWiki(db, {
				tags: wiki.actions.tags_get_all(),
				pages: wiki.actions.pages_get_all(),
			});

			const rows = db
				.query<{ title: string; d: number }, [number]>(
					'SELECT p.title, yv.duration AS d ' +
						'FROM pages p ' +
						'JOIN tag_youtube_video yv ON yv.page_id = p.id ' +
						'WHERE yv.duration > ?',
				)
				.all(500);
			expect(rows).toHaveLength(1);
			expect(rows[0]!.title).toBe('Great talk');
			expect(rows[0]!.d).toBe(999);

			// Plain tag `idea`: membership lives in page_tags, with NO side table.
			const membership = db
				.query<{ tag_id: string }, [string]>(
					'SELECT tag_id FROM page_tags WHERE page_id = ? ORDER BY tag_id',
				)
				.all(pageId)
				.map((r) => r.tag_id);
			expect(membership).toContain('idea');
			const ideaTable = db
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type='table' AND name='tag_idea'",
				)
				.all();
			expect(ideaTable).toHaveLength(0);

			// An `epicenter://` URN cell value becomes a structured_field edge,
			// detected by value (no schema marker).
			const refEdges = db
				.query<
					{ target_id: string; source_kind: string; field_id: string },
					[string]
				>(
					"SELECT target_id, source_kind, field_id FROM edges " +
						"WHERE source_id = ? AND source_kind = 'structured_field'",
				)
				.all(pageId);
			expect(refEdges).toHaveLength(1);
			expect(refEdges[0]!.target_id).toBe(
				'epicenter://whispering/recordings/rec_123',
			);
			expect(refEdges[0]!.field_id).toBe('recording');

			// A body [[id]] becomes a DISTINCT edge with a different source_kind.
			const bodyEdges = db
				.query<{ target_id: string }, [string]>(
					"SELECT target_id FROM edges " +
						"WHERE source_id = ? AND source_kind = 'body_wikilink'",
				)
				.all(pageId);
			expect(bodyEdges).toHaveLength(1);
			expect(bodyEdges[0]!.target_id).toBe('page_def');

			// `page_def` dangles (no page row); discoverable via LEFT JOIN, never an error.
			const dangling = db
				.query<{ target_id: string }, []>(
					'SELECT e.target_id FROM edges e ' +
						'LEFT JOIN pages p ON p.id = e.target_id ' +
						"WHERE p.id IS NULL AND e.source_kind = 'body_wikilink'",
				)
				.all()
				.map((r) => r.target_id);
			expect(dangling).toContain('page_def');
		} finally {
			db.close();
		}
	} finally {
		wiki[Symbol.dispose]();
		await rm(dir, { recursive: true, force: true });
	}
});

test('schema-on-read lens buckets match / excess / missing', () => {
	const columns: ColumnSpec[] = [
		...youtubeColumns,
		{ id: 'rating', name: 'Rating', schema: column.number() },
	];
	const data = {
		url: 'https://youtu.be/abc',
		duration: 'not-a-number',
		channel: 'Veritasium',
	};

	const lens = viewThroughTag({ tagId: 'youtube_video', columns, data });

	const matchById = Object.fromEntries(lens.match.map((m) => [m.id, m]));
	expect(lens.match.map((m) => m.id).sort()).toEqual(['duration', 'url']);
	expect(matchById.url!.valid).toBe(true);
	// Stored but invalid under the current schema: surfaced, never dropped.
	expect(matchById.duration!.valid).toBe(false);
	expect(lens.missing.map((m) => m.id)).toEqual(['rating']);
	expect(lens.excess.map((e) => e.id)).toEqual(['channel']);
	expect(lens.excess[0]!.value).toBe('Veritasium');
});

test('tags_define rejects a non-slug tag id and the reserved `columns`', () => {
	const wiki = createWiki();
	try {
		const bad = wiki.actions.tags_define({
			id: 'Not A Slug',
			name: 'Bad',
			columns: [{ id: 'x', name: 'X', schema: column.string() }],
		});
		expect(bad.error?.name).toBe('InvalidTagId');

		const reserved = wiki.actions.tags_define({
			id: 'columns',
			name: 'Reserved',
			columns: [],
		});
		expect(reserved.error?.name).toBe('ReservedTagId');

		expect(wiki.actions.tags_get_all()).toHaveLength(0);
	} finally {
		wiki[Symbol.dispose]();
	}
});

test('column rename is metadata-only; adding a column re-projects', () => {
	const wiki = createWiki();
	const db = new Database(':memory:');
	try {
		wiki.actions.tags_define({
			id: 'youtube_video',
			name: 'YouTube Video',
			columns: youtubeColumns,
		});
		wiki.actions.pages_create({
			title: 'clip',
			tags: { youtube_video: { url: 'https://youtu.be/abc', duration: 10 } },
		});

		const project = () =>
			projectWiki(db, {
				tags: wiki.actions.tags_get_all(),
				pages: wiki.actions.pages_get_all(),
			}).tagTableDdl.youtube_video;

		const ddlBefore = project();

		// Rename display names only; the stable column ids never change.
		wiki.actions.tags_define({
			id: 'youtube_video',
			name: 'YouTube Video',
			columns: [
				{ id: 'url', name: 'Link', schema: column.url() },
				{
					id: 'duration',
					name: 'Length',
					schema: column.nullable(column.number()),
				},
			],
		});
		expect(project()).toBe(ddlBefore); // no DDL: a rename is metadata-only

		// Add a column: the physical shape changes, so projection emits new DDL.
		wiki.actions.tags_define({
			id: 'youtube_video',
			name: 'YouTube Video',
			columns: [
				{ id: 'url', name: 'Link', schema: column.url() },
				{
					id: 'duration',
					name: 'Length',
					schema: column.nullable(column.number()),
				},
				{ id: 'rating', name: 'Rating', schema: column.number() },
			],
		});
		const ddlAfterAdd = project();
		expect(ddlAfterAdd).not.toBe(ddlBefore);
		expect(ddlAfterAdd).toContain('"rating"');
	} finally {
		db.close();
		wiki[Symbol.dispose]();
	}
});

test('pages_assign_tag auto-mints an unknown tag and wears it once', () => {
	const wiki = createWiki();
	try {
		const { id } = wiki.actions.pages_create({ title: 'Draft' });

		const assigned = wiki.actions.pages_assign_tag({ id, tagId: 'newidea' });
		expect(assigned.error).toBeNull();
		expect(assigned.data!.tags.newidea).toEqual({});

		// The unknown tag minted a bare definition at the write boundary.
		const minted = wiki.actions.tags_get_all().find((t) => t.id === 'newidea');
		expect(minted).toBeDefined();
		expect(minted!.name).toBe('newidea');
		expect(minted!.columns).toEqual([]);

		// Re-assigning overwrites the values; a page wears each tag at most once.
		const reassigned = wiki.actions.pages_assign_tag({
			id,
			tagId: 'newidea',
			values: { note: 'now structured-ish' },
		});
		expect(reassigned.data!.tags.newidea).toEqual({ note: 'now structured-ish' });
		expect(Object.keys(reassigned.data!.tags)).toEqual(['newidea']);

		// An invalid slug is rejected where the cause is visible.
		const bad = wiki.actions.pages_assign_tag({ id, tagId: 'Bad Slug' });
		expect(bad.error?.name).toBe('InvalidTagId');
	} finally {
		wiki[Symbol.dispose]();
	}
});
