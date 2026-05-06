import type { Entry } from '../routes/(signed-in)/fuji/workspace';

/**
 * Test whether an entry matches a search query.
 *
 * Checks title, subtitle, tags, and type fields against a
 * case-insensitive substring match. Returns true if any field
 * contains the query.
 */
export function matchesEntrySearch(
	entry: Pick<Entry, 'title' | 'subtitle' | 'tags' | 'type'>,
	query: string,
): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return false;
	const title = entry.title.toLowerCase();
	const subtitle = entry.subtitle.toLowerCase();
	const tags = entry.tags.join(' ').toLowerCase();
	const types = entry.type.join(' ').toLowerCase();
	return (
		title.includes(q) ||
		subtitle.includes(q) ||
		tags.includes(q) ||
		types.includes(q)
	);
}
