import type { Entry } from '../../fuji.workspace';

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
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) return false;
	const title = entry.title.toLowerCase();
	const subtitle = entry.subtitle.toLowerCase();
	const tags = entry.tags.join(' ').toLowerCase();
	const types = entry.type.join(' ').toLowerCase();
	return (
		title.includes(normalizedQuery) ||
		subtitle.includes(normalizedQuery) ||
		tags.includes(normalizedQuery) ||
		types.includes(normalizedQuery)
	);
}
