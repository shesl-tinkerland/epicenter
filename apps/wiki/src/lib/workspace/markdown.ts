/**
 * Wiki markdown export: the read-only desktop projection.
 *
 *   pages/<id>.md   frontmatter IS the page row (core columns + the nested
 *                   `types` cell); the file body IS the page `body` column,
 *                   routed out of frontmatter by the codec below.
 *   types/<id>.md   frontmatter IS the type registry row, including `columns`
 *                   whose `schema` is the TypeBox schema as JSON.
 *
 * Wiring lives here (filesystem-facing) rather than in the isomorphic factory,
 * mirroring how fuji keeps `index.ts` pure and composes IO in `browser.ts`.
 * The generated files are for reading, search, and curation. Wiki data still
 * mutates through validated workspace actions rather than disk edits.
 */

import { attachMarkdownExport } from '@epicenter/workspace/document/materializer/markdown';
import type { WikiWorkspace } from './index';

/**
 * Attach the markdown export to a wiki workspace. Returns the exporter so a
 * caller can `await whenFlushed` or invoke `actions.markdown_rebuild` to refresh
 * the read-only files.
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
				types: {},
				pages: {
					// `body` is a row column but belongs in the file body, never in
					// frontmatter; route it into the read-only markdown body.
					toMarkdown: (page) => ({
						frontmatter: {
							id: page.id,
							title: page.title,
							description: page.description,
							tags: page.tags,
							source: page.source,
							types: page.types,
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
