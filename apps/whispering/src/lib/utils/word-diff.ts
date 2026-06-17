/**
 * Word-level diff used to show a reshaped candidate against the original
 * selection.
 *
 * Splits both strings on whitespace (keeping the whitespace as its own tokens so
 * spacing round-trips), then walks a longest-common-subsequence table to tag each
 * token as unchanged, inserted (present only in the candidate), or deleted
 * (present only in the original). Good enough for sentence-to-paragraph rewrites;
 * not a Myers diff.
 */

export type DiffSegment = {
	type: 'equal' | 'insert' | 'delete';
	text: string;
};

export function wordDiff(original: string, candidate: string): DiffSegment[] {
	const a = original.split(/(\s+)/);
	const b = candidate.split(/(\s+)/);
	const m = a.length;
	const n = b.length;

	// dp[i][j] = LCS length of a[i:] and b[j:]. Read with `at` so
	// noUncheckedIndexedAccess stays satisfied without non-null assertions;
	// indices never leave bounds, so the fallback never fires.
	const at = (row: number[] | undefined, col: number) => row?.[col] ?? 0;
	const dp: number[][] = Array.from({ length: m + 1 }, () =>
		new Array<number>(n + 1).fill(0),
	);
	for (let i = m - 1; i >= 0; i--) {
		const row = dp[i];
		if (!row) continue;
		for (let j = n - 1; j >= 0; j--) {
			row[j] =
				a[i] === b[j]
					? at(dp[i + 1], j + 1) + 1
					: Math.max(at(dp[i + 1], j), at(dp[i], j + 1));
		}
	}

	const segments: DiffSegment[] = [];
	let i = 0;
	let j = 0;
	while (i < m && j < n) {
		if (a[i] === b[j]) {
			segments.push({ type: 'equal', text: a[i] ?? '' });
			i++;
			j++;
		} else if (at(dp[i + 1], j) >= at(dp[i], j + 1)) {
			segments.push({ type: 'delete', text: a[i] ?? '' });
			i++;
		} else {
			segments.push({ type: 'insert', text: b[j] ?? '' });
			j++;
		}
	}
	while (i < m) segments.push({ type: 'delete', text: a[i++] ?? '' });
	while (j < n) segments.push({ type: 'insert', text: b[j++] ?? '' });
	return segments;
}
