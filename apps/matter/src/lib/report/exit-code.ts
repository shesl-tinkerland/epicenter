/**
 * The CLI exit code. Three tiers, by how badly the vault failed:
 *
 *   - `2` a table could not be loaded at all: `unreadable` (folder unreadable) or
 *         `invalid-contract` (matter.json present but corrupt). The check could not run over that
 *         table, so this is the fatal tier, read from the {@link Summary}'s table-status totals.
 *   - `1` every table loaded, but there is at least one failing {@link Violation}.
 *   - `0` everything loaded and nothing failed. An `untyped` table (no matter.json) is a valid
 *         raw grid, never a failure, so an untyped-only vault exits 0.
 *
 * The failures are passed in, not re-derived, because WHICH violations count is the caller's
 * scope decision: a single-table check cannot evaluate its references (no target table is loaded),
 * so it drops `missing-target` to a note and passes only the rest. A whole-vault check passes every
 * violation. Keeping that choice at the edge keeps this function a pure, scope-blind verdict.
 */

import type { Summary, Violation } from '../core/violations';

type ExitCode = 0 | 1 | 2;

export function exitCodeFor(
	summary: Summary,
	failures: readonly Violation[],
): ExitCode {
	if (summary.totals.unreadable > 0 || summary.totals.invalidContract > 0) {
		return 2;
	}
	return failures.length > 0 ? 1 : 0;
}
