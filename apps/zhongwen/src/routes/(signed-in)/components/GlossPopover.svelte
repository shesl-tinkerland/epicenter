<script lang="ts">
	import { pinyin } from 'pinyin-pro';

	/**
	 * Tap-to-gloss: tapping a highlighted vocabulary word floats this card with the
	 * word's reading. The reading is local and instant (pinyin-pro); the contextual
	 * meaning is a later channel. Dismisses on an outside press, a scroll, or
	 * Escape. A press on another vocab word is left alone so the parent can reopen
	 * the card on the new word instead of this one self-closing first.
	 */
	let {
		word,
		x,
		y,
		onClose,
	}: {
		word: string;
		x: number;
		y: number;
		onClose: () => void;
	} = $props();

	let cardEl = $state<HTMLDivElement | null>(null);
	const reading = $derived(pinyin(word));
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
		class="rounded-md border bg-popover px-3 py-2 text-popover-foreground shadow-md"
	>
		<div class="text-base font-medium">{word}</div>
		<div class="text-sm text-muted-foreground">{reading}</div>
	</div>
</div>
