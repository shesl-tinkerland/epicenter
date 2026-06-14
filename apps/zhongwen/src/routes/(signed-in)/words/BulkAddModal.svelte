<script lang="ts">
	import { CalendarDateString, InstantString } from '@epicenter/field';
	import { generateTermId, type Vocabulary } from '@epicenter/zhongwen';
	import { Button } from '@epicenter/ui/button';
	import { Badge } from '@epicenter/ui/badge';
	import { Label } from '@epicenter/ui/label';
	import * as Modal from '@epicenter/ui/modal';
	import { toast } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import { ToggleGroup, ToggleGroupItem } from '@epicenter/ui/toggle-group';
	import ClipboardPasteIcon from '@lucide/svelte/icons/clipboard-paste';
	import { requireZhongwen } from '$lib/session';

	// Existing words keyed by text: the dedup source (re-adding never duplicates)
	// and the handle for rescheduling a word you already have.
	let { existingByText }: { existingByText: Map<string, Vocabulary> } = $props();

	const zhongwen = requireZhongwen();

	// What to do with lines that are already in the dictionary. Default 'skip' so
	// a re-paste is non-destructive; 'bump'/'reset' make re-adding a deliberate
	// reschedule instead of a junk duplicate.
	type ExistingAction = 'skip' | 'bump' | 'reset';

	let isOpen = $state(false);
	let rawText = $state('');
	let existingAction = $state<ExistingAction>('skip');

	// Parse to unique, trimmed, order-preserving lines, then split into the words
	// that are new vs the ones already stored (the import-time dedup query).
	const parsed = $derived.by(() => {
		const seen = new Set<string>();
		const lines: string[] = [];
		for (const raw of rawText.split('\n')) {
			const text = raw.trim();
			if (!text || seen.has(text)) continue;
			seen.add(text);
			lines.push(text);
		}
		const newTexts = lines.filter((text) => !existingByText.has(text));
		const existingWords = lines
			.map((text) => existingByText.get(text))
			.filter((word): word is Vocabulary => word !== undefined);
		return { newTexts, existingWords };
	});

	const canCommit = $derived(
		parsed.newTexts.length > 0 ||
			(parsed.existingWords.length > 0 && existingAction !== 'skip'),
	);

	function reset() {
		rawText = '';
		existingAction = 'skip';
		isOpen = false;
	}

	/**
	 * Commit the preview. New words enter at mastery 0, due today. createdAt is
	 * stamped a millisecond apart per row so a bulk paste keeps its order (the
	 * list sorts on createdAt and Yjs map order is otherwise arbitrary). Existing
	 * words are rescheduled per the chosen action, never duplicated.
	 */
	function commit() {
		const today = CalendarDateString.today();
		const base = Date.now();

		parsed.newTexts.forEach((text, index) => {
			zhongwen.tables.vocabulary.set({
				id: generateTermId(),
				text,
				mastery: 0,
				dueAt: today,
				createdAt: InstantString.from(new Date(base + index)),
			});
		});

		if (existingAction !== 'skip') {
			for (const word of parsed.existingWords) {
				zhongwen.tables.vocabulary.update(
					word.id,
					existingAction === 'reset'
						? { mastery: 0, dueAt: today }
						: { dueAt: today },
				);
			}
		}

		const added = parsed.newTexts.length;
		const rescheduled =
			existingAction === 'skip' ? 0 : parsed.existingWords.length;
		toast.success(
			[
				added > 0 && `Added ${added}`,
				rescheduled > 0 && `rescheduled ${rescheduled}`,
			]
				.filter(Boolean)
				.join(', '),
		);
		reset();
	}
</script>

<Modal.Root bind:open={isOpen}>
	<Button
		variant="outline"
		size="sm"
		tooltip="Bulk add words"
		onclick={() => (isOpen = true)}
	>
		<ClipboardPasteIcon />
		Import
	</Button>
	<Modal.Content class="sm:max-w-lg">
		<Modal.Header>
			<Modal.Title>Import words</Modal.Title>
			<Modal.Description>
				Paste a list, one word per line. Words you already have are not
				duplicated.
			</Modal.Description>
		</Modal.Header>
		<form
			class="flex flex-col gap-4"
			onsubmit={(event) => {
				event.preventDefault();
				if (canCommit) commit();
			}}
		>
			<Textarea
				bind:value={rawText}
				placeholder={'你好\n谢谢\n再见'}
				rows={8}
				class="font-mono"
			/>

			{#if parsed.newTexts.length > 0 || parsed.existingWords.length > 0}
				<div class="space-y-3 text-sm">
					<p class="text-muted-foreground">
						<span class="font-medium text-foreground">
							{parsed.newTexts.length} new
						</span>
						{#if parsed.existingWords.length > 0}
							, {parsed.existingWords.length} already in your dictionary
						{/if}
					</p>

					{#if parsed.existingWords.length > 0}
						<div class="space-y-2 rounded-md border p-3">
							<Label>Words you already have</Label>
							<div class="flex flex-wrap gap-1">
								{#each parsed.existingWords.slice(0, 30) as word (word.id)}
									<Badge variant="secondary">{word.text}</Badge>
								{/each}
								{#if parsed.existingWords.length > 30}
									<Badge variant="outline">
										+{parsed.existingWords.length - 30} more
									</Badge>
								{/if}
							</div>
							<ToggleGroup
								type="single"
								variant="outline"
								size="sm"
								value={existingAction}
								onValueChange={(value) => {
									if (value) existingAction = value as ExistingAction;
								}}
							>
								<ToggleGroupItem value="skip">Leave as-is</ToggleGroupItem>
								<ToggleGroupItem value="bump">Due today</ToggleGroupItem>
								<ToggleGroupItem value="reset">Reset to new</ToggleGroupItem>
							</ToggleGroup>
						</div>
					{/if}
				</div>
			{/if}

			<Modal.Footer>
				<Button variant="outline" type="button" onclick={reset}>Cancel</Button>
				<Button type="submit" disabled={!canCommit}>Import</Button>
			</Modal.Footer>
		</form>
	</Modal.Content>
</Modal.Root>
