/**
 * Wiki markdown vault: the one-way browse projection.
 *
 *   pages/<id>.md   frontmatter = the page core (id, title, the nested `tags`
 *                   cell, timestamps); the file body IS the page `body` column,
 *                   routed out of frontmatter by the codec below.
 *   tags/<id>.md    frontmatter = the tag registry row (columns schema as JSON,
 *                   description).
 *
 * This is a ONE-WAY read projection of the Yjs truth (the package's
 * `attachMarkdownExport`): Yjs continuously materializes to disk, and the files
 * are never read back. All writes go through validated actions (`pages_create`,
 * `pages_assign_tag`, `pages_set_body`, ...), never by editing a `.md`, the same
 * read-projection contract the rest of Epicenter settled on. Wiring lives here
 * (filesystem-facing) rather than in the isomorphic factory, mirroring how fuji
 * keeps `index.ts` pure and composes IO in `browser.ts`.
 */

import { attachMarkdownExport } from '@epicenter/workspace/document/materializer/markdown';
import type { WikiWorkspace } from './index';

/**
 * Attach the read-only markdown export to a wiki workspace. Returns the export
 * handle: `whenFlushed` (the initial Yjs -> disk flush) and `markdown_rebuild`
 * (a destructive full re-export for orphan cleanup after a layout change).
 */
export function attachWikiVault(
	wiki: WikiWorkspace,
	{ dir }: { dir: string | (() => string | Promise<string>) },
) {
	return attachMarkdownExport(
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
}

export type WikiVault = ReturnType<typeof attachWikiVault>;
