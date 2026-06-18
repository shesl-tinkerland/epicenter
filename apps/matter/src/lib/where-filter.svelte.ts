/**
 * The per-tab SQL WHERE filter over one table's slice of the vault mirror.
 *
 * Bundles the three things a filter is, the input (`text`), the result
 * (`matchedStems`), and a bad-clause `error`, plus the debounced query and its own
 * reactive lifecycle, into ONE unit. TableGrid binds `filter.text` and reads
 * `filter.matchedStems` instead of carrying three loose `$state`s and a standing effect
 * a reader has to mentally group.
 *
 * The mirror is the query seam (the vault's SQLite projection); `tableName` names which folder's SQL
 * table to query. Both are taken at construction (not per call): a tab's table is non-swappable (a
 * table switch remounts TablePane with a fresh filter), so there is nothing to re-point at call time.
 * The filter owns its own `$effect`, which Svelte ties to the component that constructs it (the same
 * pattern as `createPressedKeys`), so the caller just writes `const filter = createWhereFilter(vault.
 * mirror, () => table.folderName)`, with no effect to wire.
 *
 * The effect re-runs on two reactive reads: `text` (the clause) and `mirror.version` (bumped after
 * each mirror write or drop). Keying on the mirror's version, not the in-memory rows, means the query
 * fires only once the file it reads is actually fresh, so a data edit can never land a result from the
 * pre-rebuild mirror. Each run debounces, and its cleanup cancels the pending/in-flight query so a
 * newer clause or rebuild never lands a stale result set.
 */

import type { Mirror } from './mirror.svelte';

/** Let a burst of keystrokes (or rapid external edits) settle before querying the mirror. */
const DEBOUNCE_MS = 200;

export function createWhereFilter(mirror: Mirror, tableName: () => string) {
	let text = $state('');
	let matchedStems = $state<Set<string>>();
	let error = $state<string>();

	// Resolve the current clause to matched names whenever the clause or the mirror changes.
	// Reading `mirror.version` (discarded) is the subscription: it bumps after each mirror write/drop,
	// so the query below always reads a fresh file. The cleanup cancels the pending/in-flight query so
	// a newer clause or rebuild never lands a stale set.
	$effect(() => {
		const clause = text.trim();
		void mirror.version; // re-run after the mirror is rebuilt (downstream of row edits)
		// Empty clause: there is no filter, so show every row.
		if (!clause) {
			matchedStems = undefined;
			error = undefined;
			return;
		}
		let cancelled = false;
		const handle = setTimeout(async () => {
			const { data, error: failure } = await mirror.query(tableName(), clause);
			if (cancelled) return; // a newer clause, a rebuild, or this tab being torn down won
			if (failure) error = failure.message;
			else {
				matchedStems = data;
				error = undefined;
			}
		}, DEBOUNCE_MS);
		return () => {
			cancelled = true;
			clearTimeout(handle);
		};
	});

	return {
		/** The WHERE clause, two-way bound to the folder-header input. */
		get text() {
			return text;
		},
		set text(value: string) {
			text = value;
		},
		/** The stems the clause matched, or `undefined` when no clause is active. */
		get matchedStems() {
			return matchedStems;
		},
		/** A bad clause's message; the last good `matchedStems` is kept until it parses. */
		get error() {
			return error;
		},
	};
}

/** A per-tab WHERE filter. The grid takes one to render its header input and narrow rows. */
export type WhereFilter = ReturnType<typeof createWhereFilter>;
