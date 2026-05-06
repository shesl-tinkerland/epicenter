import {
	attachTable,
	type TableDefinitions,
	type Tables,
} from '../index.js';
import type * as Y from 'yjs';

/**
 * Test-only convenience: attach every table in a definitions map to a Y.Doc.
 * Mirrors the shape production code uses internally without pulling in
 * encryption, extensions, or builder plumbing.
 */
export function createTables<T extends TableDefinitions>(
	ydoc: Y.Doc,
	definitions: T,
): Tables<T> {
	const entries = Object.entries(definitions).map(([name, def]) => [
		name,
		attachTable(ydoc, name, def),
	]);
	return Object.fromEntries(entries) as Tables<T>;
}
