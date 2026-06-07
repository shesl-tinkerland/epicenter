/**
 * The per-tab SQL WHERE filter over a vault's mirror.
 *
 * Bundles the three things a filter is, the input (`text`), the result
 * (`matchedFileNames`), and a bad-clause `error`, plus the debounced query into ONE unit, so
 * VaultView binds `filter.text` and reads `filter.matchedFileNames` instead of carrying three
 * loose `$state`s and an inline effect that a reader has to mentally group. The states
 * still exist (reactive state is always `let $state`); this just gives them an owner and
 * a name.
 *
 * The vault is passed to `resolve` at call time (not captured) so the dependency is visible
 * at the call site and the reactive read happens in VaultView's effect, not buried here. Each
 * tab is its own VaultView with its own filter over a single, non-swappable vault (a folder
 * switch remounts VaultView), so `resolve` always gets a live vault. VaultView drives it with
 * `$effect(() => filter.resolve(vault))`: the effect reads `vault.read` (inside `resolve`), so
 * it re-runs when the rows change, and `resolve` returns a cleanup that cancels an in-flight
 * query so a newer clause or a data change never lands a stale result set.
 */

import type { Vault } from './vault.svelte';

/** Let a burst of keystrokes (or rapid external edits) settle before querying the mirror. */
const DEBOUNCE_MS = 200;

export function createWhereFilter() {
	let text = $state('');
	let matchedFileNames = $state<Set<string>>();
	let error = $state<string>();

	/**
	 * Resolve the current clause to matched names against `vault`. Call inside an `$effect`
	 * so the reactive read (`vault.read`) is tracked; the returned cleanup cancels the
	 * pending/in-flight query so only the latest run can assign. `vault` is passed in rather
	 * than captured so the dependency is visible at the call site.
	 */
	function resolve(vault: Vault): (() => void) | void {
		const clause = text.trim();
		void vault.read; // re-run when rows change so an edit updates membership
		// Empty clause: there is no filter, so show every row.
		if (!clause) {
			matchedFileNames = undefined;
			error = undefined;
			return;
		}
		let cancelled = false;
		const handle = setTimeout(async () => {
			const { data, error: failure } = await vault.matchingFileNames(clause);
			if (cancelled) return; // a newer clause, a data change, or this tab being torn down won
			if (failure) error = failure.message;
			else {
				matchedFileNames = data;
				error = undefined;
			}
		}, DEBOUNCE_MS);
		return () => {
			cancelled = true;
			clearTimeout(handle);
		};
	}

	return {
		resolve,
		/** The WHERE clause, two-way bound to the folder-header input. */
		get text() {
			return text;
		},
		set text(value: string) {
			text = value;
		},
		/** The names the clause matched, or `undefined` when no clause is active. */
		get matchedFileNames() {
			return matchedFileNames;
		},
		/** A bad clause's message; the last good `matchedFileNames` is kept until it parses. */
		get error() {
			return error;
		},
	};
}
