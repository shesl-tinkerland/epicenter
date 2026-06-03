/**
 * Wiki markdown vault: the browse projection plus a disk-to-Yjs reconcile.
 *
 *   pages/<id>.md   frontmatter = the page core (id, title, the nested `tags`
 *                   cell, timestamps); the file body IS the page `body` column,
 *                   routed out of frontmatter by the codec below.
 *   tags/<id>.md    frontmatter = the tag registry row (columns schema as JSON,
 *                   description).
 *
 * The Yjs -> disk direction is the package's read-only `attachMarkdownExport`:
 * a continuously-materialized, one-way projection. The disk -> Yjs direction is
 * `markdown_push` below, a deliberate reconcile a human triggers after editing
 * files in the vault (not a live two-way binding). It parses each file,
 * validates it against the table shape, auto-mints any unknown tag the page
 * wears, and writes rows back into Yjs. Wiring lives here (filesystem-facing)
 * rather than in the isomorphic factory, mirroring how fuji keeps `index.ts`
 * pure and composes IO in `browser.ts`.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { attachMarkdownExport } from '@epicenter/workspace/document/materializer/markdown';
import { parseMarkdownFile } from '@epicenter/workspace/markdown';
import { createLogger } from 'wellcrafted/logger';
import { type WikiWorkspace, mintMissingTags } from './index';
import {
	asPageId,
	asTagId,
	isTSchemaObject,
	type Page,
	type WikiTag,
} from './schema';

/** Outcome of one `markdown_push`: rows written back and files that failed. */
type MarkdownPushResult = { pushed: number; errored: number };

/**
 * Attach the markdown vault to a wiki workspace. Returns `whenFlushed` (the
 * initial Yjs -> disk flush) plus the `markdown_push` reconcile and the
 * export's destructive `markdown_rebuild`.
 */
export function attachWikiVault(
	wiki: WikiWorkspace,
	{ dir }: { dir: string | (() => string | Promise<string>) },
) {
	const log = createLogger('wiki-vault');
	const resolveDir = async () =>
		typeof dir === 'function' ? await dir() : dir;

	const exported = attachMarkdownExport(
		{ ydoc: wiki.ydoc, tables: wiki.tables },
		{
			dir,
			tables: {
				// Default whole-row frontmatter: the registry row, columns schema and
				// description included.
				tags: {},
				pages: {
					// `body` is a row column but belongs in the file body, never in
					// frontmatter; route it across.
					toMarkdown: (page) => ({
						frontmatter: {
							id: page.id,
							title: page.title,
							tags: page.tags,
							createdAt: page.createdAt,
							updatedAt: page.updatedAt,
						},
						body: page.body.length > 0 ? page.body : undefined,
					}),
				},
			},
		},
	);

	/**
	 * Read every `<subdir>/*.md`, returning each parsed file. A missing directory
	 * (nothing materialized yet) reads as empty; a non-`.md` entry is skipped.
	 */
	async function readVaultDir(
		subdir: string,
	): Promise<{ frontmatter: Record<string, unknown>; body: string | undefined }[]> {
		const baseDir = await resolveDir();
		const fullDir = join(baseDir, subdir);
		let entries: string[];
		try {
			entries = await readdir(fullDir);
		} catch {
			return [];
		}
		const parsed: {
			frontmatter: Record<string, unknown>;
			body: string | undefined;
		}[] = [];
		for (const entry of entries) {
			if (!entry.endsWith('.md')) continue;
			const content = await readFile(join(fullDir, entry), 'utf-8');
			const file = parseMarkdownFile(content);
			if (file === null) {
				log.info(`skipping ${subdir}/${entry}: no frontmatter`);
				continue;
			}
			parsed.push(file);
		}
		return parsed;
	}

	/**
	 * Disk -> Yjs reconcile. Tags push first so their definitions exist, then
	 * pages; any tag a page wears without a registry row auto-mints a bare
	 * definition (the same mint the assign action does), so `page_tags` always
	 * resolves after a push.
	 */
	async function markdownPush(): Promise<MarkdownPushResult> {
		let pushed = 0;
		let errored = 0;

		for (const file of await readVaultDir('tags')) {
			const row = file.frontmatter as unknown as WikiTag;
			const columns = row.columns ?? [];
			// Match the define action's gate: a hand-edited column schema that is
			// not a JSON object is rejected at import rather than silently degrading
			// in projection / lens.
			const badColumn = columns.find((spec) => !isTSchemaObject(spec.schema));
			if (badColumn) {
				log.info(
					`tag "${row.id}" column "${badColumn.id}" schema is not a TSchema object; skipping`,
				);
				errored++;
				continue;
			}
			wiki.tables.tags.set({
				id: asTagId(String(row.id)),
				name: String(row.name ?? row.id),
				icon: (row.icon ?? null) as WikiTag['icon'],
				columns: row.columns,
				description: (row.description ?? null) as WikiTag['description'],
				createdAt: row.createdAt,
				updatedAt: row.updatedAt,
			});
			pushed++;
		}

		const wornTagIds = new Set<string>();
		for (const file of await readVaultDir('pages')) {
			const fm = file.frontmatter;
			const tags = (fm.tags ?? {}) as Page['tags'];
			for (const tagId of Object.keys(tags)) wornTagIds.add(tagId);
			wiki.tables.pages.set({
				id: asPageId(String(fm.id)),
				title: String(fm.title ?? ''),
				body: file.body ?? '',
				tags,
				createdAt: fm.createdAt as Page['createdAt'],
				updatedAt: fm.updatedAt as Page['updatedAt'],
			});
			pushed++;
		}

		// Mint any worn-but-undefined tag, so membership always resolves.
		mintMissingTags(wiki.tables, wornTagIds);

		return { pushed, errored };
	}

	return {
		whenFlushed: exported.whenFlushed,
		actions: {
			markdown_rebuild: exported.actions.markdown_rebuild,
			markdown_push: markdownPush,
		},
	};
}

export type WikiVault = ReturnType<typeof attachWikiVault>;
