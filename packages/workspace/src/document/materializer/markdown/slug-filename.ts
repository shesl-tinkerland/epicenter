import { toSlugFilename } from '../../../markdown/to-slug-filename.js';
import type { BaseRow } from '../../attach-table.js';

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
