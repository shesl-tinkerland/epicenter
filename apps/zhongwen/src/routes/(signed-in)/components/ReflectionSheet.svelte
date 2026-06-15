<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import * as Item from '@epicenter/ui/item';
	import * as Sheet from '@epicenter/ui/sheet';
	import type { TermId, Vocabulary } from '@epicenter/zhongwen';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import type { Snippet } from 'svelte';
	import { MASTERY_LABELS } from '$lib/mastery';
	import type { ReflectionRoster } from '$lib/reflection';
	import MasteryToggle from './MasteryToggle.svelte';

	/**
	 * The reflection moment: wrap up a chat and bump comfort on the words it
	 * practiced while the experience is fresh. The roster is a snapshot taken at
	 * Finish (so a bump never reshuffles the buckets mid-review), but each row's
	 * toggle reads its CURRENT mastery from the live `words` array, so the control
	 * reflects what the learner just tapped. Closing without bumping is free.
	 */
	let {
		open = $bindable(),
		roster,
		words,
		onBump,
	}: {
		open: boolean;
		roster: ReflectionRoster;
		words: Vocabulary[];
		onBump: (id: TermId, mastery: Vocabulary['mastery']) => void;
	} = $props();

	const liveById = $derived(new Map(words.map((word) => [word.id, word])));
	const isEmpty = $derived(
		roster.used.length === 0 &&
			roster.met.length === 0 &&
			roster.missed.length === 0,
	);
</script>

{#snippet section(title: string, description: string, rows: Vocabulary[])}
	{#if rows.length > 0}
		<section class="space-y-2">
			<div>
				<h3 class="text-sm font-medium">{title}</h3>
				<p class="text-xs text-muted-foreground">{description}</p>
			</div>
			<Item.Group>
				{#each rows as word (word.id)}
					{@const current = liveById.get(word.id)?.mastery ?? word.mastery}
					<Item.Root variant="outline">
						<Item.Content>
							<Item.Title class="text-base">{word.text}</Item.Title>
							<Item.Description>{MASTERY_LABELS[current]}</Item.Description>
						</Item.Content>
						<Item.Actions>
							<MasteryToggle
								mastery={current}
								onChange={(mastery) => onBump(word.id, mastery)}
							/>
						</Item.Actions>
					</Item.Root>
				{/each}
			</Item.Group>
		</section>
	{/if}
{/snippet}

<Sheet.Root bind:open>
	<Sheet.Content side="bottom" class="max-h-[85dvh] overflow-y-auto">
		<Sheet.Header>
			<Sheet.Title>Wrap up this chat</Sheet.Title>
			<Sheet.Description>
				The words this conversation practiced. Bump anything that feels more
				comfortable now, or just close this.
			</Sheet.Description>
		</Sheet.Header>

		{#if isEmpty}
			<Empty.Root class="min-h-48 border-0">
				<Empty.Media variant="icon">
					<SparklesIcon class="size-5" />
				</Empty.Media>
				<Empty.Title>No words to review</Empty.Title>
				<Empty.Description>
					None of your dictionary words came up in this chat yet.
				</Empty.Description>
			</Empty.Root>
		{:else}
			<div class="space-y-6 px-4 pb-4">
				{@render section(
					'You used',
					'You produced these yourself.',
					roster.used,
				)}
				{@render section(
					'You met',
					'These appeared in the replies.',
					roster.met,
				)}
				{@render section(
					"Didn't come up",
					'Targeted for today, but this chat did not reach them.',
					roster.missed,
				)}
			</div>
		{/if}
	</Sheet.Content>
</Sheet.Root>
