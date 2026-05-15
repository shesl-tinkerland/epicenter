import slugify from '@sindresorhus/slugify';
import filenamify from 'filenamify';
import type { BaseRow } from '../../attach-table.js';

/** Max slug length before the ID suffix. */
const MAX_SLUG_LENGTH = 50;

/** Build an ID-only filename: `{id}.md`. */
function toIdFilename(id: string): string {
	return `${id}.md`;
}

/**
 * Build a `{slugified-title}-{id}.md` filename, falling back to `{id}.md`
 * when the title is empty.
 */
function toSlugFilename(title: string | undefined | null, id: string): string {
	if (!title || title.trim().length === 0) {
		return toIdFilename(id);
	}

	const slug = slugify(title).slice(0, MAX_SLUG_LENGTH);
	const raw = slug ? `${slug}-${id}.md` : toIdFilename(id);
	return filenamify(raw, { replacement: '-' });
}

/**
 * Build a `filename` slot that produces `{slug}-{id}.md` using a row field
 * as the slug source. Pass to `.table(t, { filename: slugFilename('title') })`.
 *
 * @example
 * ```typescript
 * .table(tables.posts, { filename: slugFilename('title') })
 * // row with title "Hello World", id "abc123" => "hello-world-abc123.md"
 * ```
 */
export function slugFilename<TRow extends BaseRow>(
	field: keyof TRow & string,
): (row: TRow) => string {
	return (row) => {
		const value = row[field];
		return toSlugFilename(
			typeof value === 'string' ? value : undefined,
			String(row.id),
		);
	};
}
