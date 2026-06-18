<script lang="ts">
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import type { VaultIntegrity } from '$lib/core/integrity';
	import { describeExpected, formatExpected } from '$lib/core/expected';
	import {
		summarize,
		toViolations,
		type Violation,
	} from '$lib/core/violations';

	// The one "what is wrong" surface for the whole vault, a pure selector over the live
	// VaultIntegrity. It re-decides nothing: `toViolations` and `summarize` read the same assessed
	// cells the grid renders, so the panel and the grid can never disagree.
	let { integrity }: { integrity: VaultIntegrity } = $props();

	const summary = $derived(summarize(integrity));
	const violations = $derived(toViolations(integrity));

	// Tables that could not load at all: not violations (they have no cells), surfaced on their own.
	const fatals = $derived(
		summary.tables.filter(
			(table) =>
				table.status === 'unreadable' || table.status === 'invalid-contract',
		),
	);

	const clean = $derived(violations.length === 0 && fatals.length === 0);

	/** One human line per violation, expected computed at the edge for an invalid value. */
	function describe(violation: Violation): string {
		switch (violation.kind) {
			case 'missing-target':
				return `${violation.table}.${violation.field} → ${violation.target}: table not in this vault`;
			case 'missing-required':
				return `${violation.table}/${violation.row}: ${violation.field} needs a value`;
			case 'invalid-type':
				return `${violation.table}/${violation.row}: ${violation.field} is invalid (expected ${formatExpected(describeExpected(violation.field))})`;
			case 'dangling-reference':
				return `${violation.table}/${violation.row}: ${violation.field} → "${violation.value}" is not a row in ${violation.target}`;
		}
	}
</script>

<aside class="border-t bg-muted/30 text-xs">
	<div class="flex items-center gap-2 px-3 py-1.5 font-medium">
		{#if clean}
			<CircleCheckIcon class="size-3.5 text-emerald-600 dark:text-emerald-400" />
			<span>
				All references resolve · {summary.totals.ready} ready across {summary
					.totals.tables}
				{summary.totals.tables === 1 ? 'table' : 'tables'}
			</span>
		{:else}
			<TriangleAlertIcon class="size-3.5 text-amber-600 dark:text-amber-400" />
			<span>
				{violations.length + fatals.length}
				{violations.length + fatals.length === 1 ? 'issue' : 'issues'} · {summary
					.totals.ready} ready
			</span>
		{/if}
	</div>

	{#if !clean}
		<ul class="max-h-40 space-y-1 overflow-y-auto border-t px-3 py-1.5">
			{#each fatals as table (table.name)}
				<li class="flex gap-2 text-destructive">
					<span class="font-mono">{table.name}</span>
					<span class="text-muted-foreground">
						{table.status === 'unreadable' ? "can't read" : 'invalid contract'}:
						{'message' in table ? table.message : ''}
					</span>
				</li>
			{/each}
			{#each violations as violation, index (index)}
				<li
					class={[
						'flex gap-2',
						violation.kind === 'missing-target'
							? 'text-amber-700 dark:text-amber-400'
							: 'text-destructive',
					]}
				>
					<span>{describe(violation)}</span>
				</li>
			{/each}
		</ul>
	{/if}
</aside>
