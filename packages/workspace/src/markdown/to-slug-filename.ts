import slugify from '@sindresorhus/slugify';
import filenamify from 'filenamify';

const MAX_SLUG_LENGTH = 50;

/**
 * Build a human-readable filename `{slugified-title}-{id}.md`, falling back
 * to `{id}.md` when the title is empty.
 *
 * @example
 * ```typescript
 * toSlugFilename('GitHub PR Review', 'abc123')
 * // 'github-pr-review-abc123.md'
 *
 * toSlugFilename(undefined, 'abc123')
 * // 'abc123.md'
 * ```
 */
export function toSlugFilename(
	title: string | undefined | null,
	id: string,
): string {
	if (!title || title.trim().length === 0) {
		return `${id}.md`;
	}

	const slug = slugify(title).slice(0, MAX_SLUG_LENGTH);
	const raw = slug ? `${slug}-${id}.md` : `${id}.md`;
	return filenamify(raw, { replacement: '-' });
}
