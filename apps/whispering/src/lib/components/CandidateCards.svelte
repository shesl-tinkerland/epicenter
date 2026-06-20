<script lang="ts">
	import * as Card from '@epicenter/ui/card';
	import { Kbd } from '@epicenter/ui/kbd';
	import { Spinner } from '@epicenter/ui/spinner';
	import { Toggle } from '@epicenter/ui/toggle';
	import type { Result } from 'wellcrafted/result';
	import { cn } from '@epicenter/ui/utils';
	import { type DiffSegment, wordDiff } from '$lib/utils/word-diff';

	/**
	 * The minimal shape this list needs from a candidate: a stable key, the source
	 * transformation's title, and a promise of its output (or a failure). The
	 * operations-layer `Candidate` is assignable to this. Each `result` resolves
	 * independently, so cards fill in as their completions land.
	 */
	export type CardCandidate = {
		id: string;
		transformation: { title: string };
		result: Promise<Result<string, { message: string }>>;
	};

	let {
		candidates,
		original,
		selectedIndex = $bindable(0),
		onaccept,
	}: {
		candidates: CardCandidate[];
		/** The text each candidate is diffed against. */
		original: string;
		selectedIndex?: number;
		/** Accept the currently selected candidate (read it via `selectedIndex`). */
		onaccept: () => void;
	} = $props();

	// Show the word diff against the original, or the clean result text. Local to
	// this component; no caller controls it, so it is state, not a bindable prop.
	let showDiff = $state(true);

	let listEl = $state<HTMLElement | null>(null);

	// Keep the highlighted card visible as selection moves through a long list.
	$effect(() => {
		listEl
			?.querySelector(`[data-candidate-index="${selectedIndex}"]`)
			?.scrollIntoView({ block: 'nearest' });
	});

	// Tailwind classes per diff segment kind; unchanged words stay unstyled.
	const SEGMENT_CLASS = {
		equal: '',
		insert: 'rounded-sm bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
		delete:
			'rounded-sm bg-red-500/10 text-red-700/70 line-through dark:text-red-300/60',
	} as const satisfies Record<DiffSegment['type'], string>;
</script>

{#snippet diffInline(segments: DiffSegment[])}
	<p class="text-sm leading-relaxed whitespace-pre-wrap">
		{#each segments as seg, i (i)}<span class={SEGMENT_CLASS[seg.type]}
				>{seg.text}</span
			>{/each}
	</p>
{/snippet}

<div class="flex min-h-0 flex-1 flex-col gap-2">
	<div class="flex flex-none items-center justify-end">
		<Toggle
			bind:pressed={showDiff}
			size="sm"
			aria-label="Toggle diff view"
			class="h-7 px-2 text-xs text-muted-foreground"
		>
			Diff
		</Toggle>
	</div>

	<div
		bind:this={listEl}
		class="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto pr-1"
	>
		{#each candidates as candidate, index (candidate.id)}
			{@const selected = index === selectedIndex}
			<Card.Root
				data-candidate-index={index}
				role="button"
				tabindex={0}
				aria-selected={selected}
				onclick={() => (selectedIndex = index)}
				ondblclick={() => {
					selectedIndex = index;
					onaccept();
				}}
				class={cn(
					'cursor-pointer gap-2 border py-3 transition-colors outline-none',
					selected
						? 'border-l-2 border-l-foreground/40 bg-accent shadow-sm'
						: 'bg-card hover:bg-accent/40',
				)}
			>
				<Card.Header class="flex-row items-center justify-between gap-2 px-4">
					<span class="text-sm font-medium">
						{candidate.transformation.title || 'Untitled transformation'}
					</span>
					{#if selected}
						<span class="flex items-center gap-1 text-xs text-muted-foreground">
							<Kbd>Enter</Kbd> to accept
						</span>
					{/if}
				</Card.Header>
				<Card.Content class="px-4">
					{#await candidate.result}
						<div class="flex items-center gap-2 text-sm text-muted-foreground">
							<Spinner class="size-3.5" />
							<span>Generating</span>
						</div>
					{:then result}
						{#if result.error}
							<p class="text-sm text-destructive">{result.error.message}</p>
						{:else if showDiff}
							{@render diffInline(wordDiff(original, result.data))}
						{:else}
							<p class="text-sm leading-relaxed whitespace-pre-wrap">
								{result.data}
							</p>
						{/if}
					{/await}
				</Card.Content>
			</Card.Root>
		{/each}
	</div>
</div>
