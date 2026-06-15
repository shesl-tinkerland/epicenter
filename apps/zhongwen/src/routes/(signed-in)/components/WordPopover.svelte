<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import LanguagesIcon from '@lucide/svelte/icons/languages';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { pinyin } from 'pinyin-pro';
	import { streamGloss } from '$lib/gloss';

	/**
	 * One anchored surface over a word or phrase in the chat, in two phases:
	 *
	 *   actions  the [Add] / [What's this?] toolbar shown for a fresh selection
	 *   meaning  the reading (pinyin, instant) plus the streamed contextual meaning
	 *
	 * A tap on a lens-highlighted word opens straight in `meaning`; a free
	 * selection opens in `actions`, and "What's this?" walks it to `meaning`. The
	 * phase is owned by the parent (single source of truth), so this stays a
	 * renderer. Dismisses on an outside press, a scroll, or Escape; a press on
	 * another highlighted word is left alone so the parent can reopen on it.
	 *
	 * No selection-preservation hack: the popover reads its `text` from props, not
	 * the live selection, so a button press collapsing the selection is harmless.
	 */
	let {
		text,
		context,
		provider,
		model,
		fetchFn,
		phase,
		x,
		y,
		onAdd,
		onAskMeaning,
		onClose,
	}: {
		text: string;
		context: string;
		provider: string;
		model: string;
		fetchFn: typeof fetch;
		phase: 'actions' | 'meaning';
		x: number;
		y: number;
		onAdd: () => void;
		onAskMeaning: () => void;
		onClose: () => void;
	} = $props();

	let cardEl = $state<HTMLDivElement | null>(null);
	const reading = $derived(pinyin(text));

	let meaning = $state('');
	let failed = $state(false);

	$effect(() => {
		// Stream only once we are showing the meaning; re-run when the word changes
		// (a tap on a different word). Abort on dismiss, retap, or Escape.
		if (phase !== 'meaning') return;
		const controller = new AbortController();
		meaning = '';
		failed = false;
		streamGloss({
			fetchFn,
			word: text,
			context,
			provider,
			model,
			signal: controller.signal,
			onText: (next) => {
				meaning = next;
			},
		}).catch(() => {
			if (!controller.signal.aborted) failed = true;
		});
		return () => controller.abort();
	});
</script>

<svelte:document
	onpointerdown={(event) => {
		const target = event.target as HTMLElement;
		if (cardEl?.contains(target) || target.closest('[data-vocab]')) return;
		onClose();
	}}
	onscrollcapture={onClose}
	onkeydown={(event) => event.key === 'Escape' && onClose()}
/>

<div
	bind:this={cardEl}
	class="fixed z-50 -translate-x-1/2 -translate-y-full pb-1"
	style="left: {x}px; top: {y}px"
>
	{#if phase === 'actions'}
		<div class="flex gap-1">
			<Button size="sm" onclick={onAdd}>
				<PlusIcon class="size-3.5" />
				Add {text}
			</Button>
			<Button size="sm" variant="secondary" onclick={onAskMeaning}>
				<LanguagesIcon class="size-3.5" />
				What's this?
			</Button>
		</div>
	{:else}
		<div
			class="max-w-xs rounded-md border bg-popover px-3 py-2 text-popover-foreground shadow-md"
		>
			<div class="text-base font-medium">{text}</div>
			<div class="text-sm text-muted-foreground">{reading}</div>
			{#if failed}
				<div class="mt-1 text-sm text-destructive">
					Couldn't load the meaning.
				</div>
			{:else if meaning}
				<div class="mt-1 text-sm">{meaning}</div>
			{:else}
				<Spinner class="mt-1 size-3.5 text-muted-foreground" />
			{/if}
		</div>
	{/if}
</div>
