<script lang="ts">
	import { CalendarDateString, InstantString } from '@epicenter/field';
	import { fromTable } from '@epicenter/svelte';
	import {
		generateTermId,
		type TermId,
		type Vocabulary,
	} from '@epicenter/zhongwen';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import * as Item from '@epicenter/ui/item';
	import { toast } from '@epicenter/ui/sonner';
	import * as Tabs from '@epicenter/ui/tabs';
	import { ToggleGroup, ToggleGroupItem } from '@epicenter/ui/toggle-group';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import BookOpenIcon from '@lucide/svelte/icons/book-open';
	import { onDestroy } from 'svelte';
	import { requireZhongwen } from '$lib/session';

	const zhongwen = requireZhongwen();
	const vocabularyMap = fromTable(zhongwen.tables.vocabulary);

	// Oldest first: instant strings sort chronologically as plain strings, so the
	// list reads in the order words were added (the same order a bulk paste lands).
	const words = $derived(
		[...vocabularyMap.values()].sort((a, b) =>
			a.createdAt.localeCompare(b.createdAt),
		),
	);

	// mastery is the self-reported comfort (0 new, 1 learning, 2 known); it is
	// the filter, the toggle value, and (later) the review interval input.
	const MASTERY_LABELS: Record<number, string> = {
		0: 'New',
		1: 'Learning',
		2: 'Known',
	};

	// Tab keys map onto a mastery bucket; the absent key ('all') means no filter.
	const MASTERY_BY_TAB: Record<string, Vocabulary['mastery']> = {
		new: 0,
		learning: 1,
		known: 2,
	};

	let activeTab = $state('all');
	const filtered = $derived(
		activeTab in MASTERY_BY_TAB
			? words.filter((word) => word.mastery === MASTERY_BY_TAB[activeTab])
			: words,
	);

	const counts = $derived({
		all: words.length,
		new: words.filter((word) => word.mastery === 0).length,
		learning: words.filter((word) => word.mastery === 1).length,
		known: words.filter((word) => word.mastery === 2).length,
	});

	let draft = $state('');

	/**
	 * Add a word at mastery 0, due today. Real dedup (the import-time preview and
	 * re-add reschedule) is increment 3; here a duplicate exact `text` is simply
	 * refused so the single-add input never plants a junk duplicate row.
	 */
	function addWord() {
		const text = draft.trim();
		if (!text) return;
		if (words.some((word) => word.text === text)) {
			toast.info(`"${text}" is already in your dictionary`);
			return;
		}
		zhongwen.tables.vocabulary.set({
			id: generateTermId(),
			text,
			mastery: 0,
			dueAt: CalendarDateString.today(),
			createdAt: InstantString.now(),
		});
		draft = '';
	}

	/**
	 * Self-report writes mastery directly. dueAt advancement on review is
	 * increment 4, so this deliberately patches mastery alone.
	 */
	function setMastery(id: TermId, mastery: Vocabulary['mastery']) {
		zhongwen.tables.vocabulary.update(id, { mastery });
	}

	onDestroy(() => {
		vocabularyMap[Symbol.dispose]();
	});
</script>

<main class="mx-auto flex h-dvh w-full max-w-2xl flex-col">
	<header class="flex items-center gap-3 border-b px-4 py-3">
		<Button variant="ghost" size="icon" href="/" tooltip="Back to chat">
			<ArrowLeftIcon />
		</Button>
		<h1 class="text-lg font-semibold">Words</h1>
	</header>

	<form
		class="flex items-center gap-2 border-b px-4 py-3"
		onsubmit={(event) => {
			event.preventDefault();
			addWord();
		}}
	>
		<Input
			bind:value={draft}
			placeholder="Add a word, e.g. 你好"
			aria-label="Add a word to your dictionary"
		/>
		<Button type="submit" disabled={!draft.trim()}>Add</Button>
	</form>

	<div class="px-4 py-3">
		<Tabs.Root bind:value={activeTab}>
			<Tabs.List class="w-full">
				<Tabs.Trigger value="all">All ({counts.all})</Tabs.Trigger>
				<Tabs.Trigger value="new">New ({counts.new})</Tabs.Trigger>
				<Tabs.Trigger value="learning">
					Learning ({counts.learning})
				</Tabs.Trigger>
				<Tabs.Trigger value="known">Known ({counts.known})</Tabs.Trigger>
			</Tabs.List>
		</Tabs.Root>
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
		{#if filtered.length === 0}
			<Empty.Root class="min-h-64 border-0">
				<Empty.Media variant="icon">
					<BookOpenIcon class="size-5" />
				</Empty.Media>
				<Empty.Title>
					{words.length === 0 ? 'No words yet' : 'Nothing in this filter'}
				</Empty.Title>
				<Empty.Description>
					{words.length === 0
						? 'Add a word above to start your dictionary.'
						: 'Mark words with the comfort buttons to fill this bucket.'}
				</Empty.Description>
			</Empty.Root>
		{:else}
			<Item.Group>
				{#each filtered as word (word.id)}
					<Item.Root variant="outline">
						<Item.Content>
							<Item.Title class="text-base">{word.text}</Item.Title>
							<Item.Description>{MASTERY_LABELS[word.mastery]}</Item.Description>
						</Item.Content>
						<Item.Actions>
							<ToggleGroup
								type="single"
								variant="outline"
								size="sm"
								value={String(word.mastery)}
								onValueChange={(value) => {
									if (value) setMastery(word.id, Number(value));
								}}
							>
								<ToggleGroupItem value="0" aria-label="Mark as new">
									New
								</ToggleGroupItem>
								<ToggleGroupItem value="1" aria-label="Mark as learning">
									Learning
								</ToggleGroupItem>
								<ToggleGroupItem value="2" aria-label="Mark as known">
									Known
								</ToggleGroupItem>
							</ToggleGroup>
						</Item.Actions>
					</Item.Root>
				{/each}
			</Item.Group>
		{/if}
	</div>
</main>
