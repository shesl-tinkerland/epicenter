<script lang="ts">
	import { pinyin } from 'pinyin-pro';
	import { streamGloss } from '$lib/gloss';

	/**
	 * Tap-to-gloss: tapping a highlighted vocabulary word floats this card with the
	 * word's reading and its meaning in context. The reading is local and instant
	 * (pinyin-pro); the meaning streams from the model on the out-of-band chat
	 * route, so it never lands in the transcript. Dismisses on an outside press, a
	 * scroll, or Escape. A press on another vocab word is left alone so the parent
	 * can reopen the card on the new word instead of this one self-closing first.
	 */
	let {
		word,
		context,
		provider,
		model,
		fetchFn,
		x,
		y,
		onClose,
	}: {
		word: string;
		context: string;
		provider: string;
		model: string;
		fetchFn: typeof fetch;
		x: number;
		y: number;
		onClose: () => void;
	} = $props();

	let cardEl = $state<HTMLDivElement | null>(null);
	const reading = $derived(pinyin(word));

	let meaning = $state('');
	let failed = $state(false);

	$effect(() => {
		// Re-stream whenever the tapped word changes; abort on dismiss or retap so a
		// stale gloss never lands in the card.
		const controller = new AbortController();
		meaning = '';
		failed = false;
		streamGloss({
			fetchFn,
			word,
			context,
			provider,
			model,
			signal: controller.signal,
			onText: (text) => {
				meaning = text;
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
	<div
		class="max-w-xs rounded-md border bg-popover px-3 py-2 text-popover-foreground shadow-md"
	>
		<div class="text-base font-medium">{word}</div>
		<div class="text-sm text-muted-foreground">{reading}</div>
		{#if failed}
			<div class="mt-1 text-sm text-destructive">
				Couldn't load the meaning.
			</div>
		{:else if meaning}
			<div class="mt-1 text-sm">{meaning}</div>
		{:else}
			<div class="mt-1 text-sm text-muted-foreground">…</div>
		{/if}
	</div>
</div>
