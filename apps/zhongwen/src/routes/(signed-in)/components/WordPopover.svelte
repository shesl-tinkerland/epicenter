<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import LanguagesIcon from '@lucide/svelte/icons/languages';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { pinyin } from 'pinyin-pro';
	import { cachedGloss, streamGloss } from '$lib/gloss';

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
	 *
	 * Placement is measured, not transform-based, so the card stays on screen: it
	 * centers on the word's `x`, then clamps to the viewport horizontally and flips
	 * below the word when there is no room above (a word on the first line). The
	 * anchor is the word's vertical span (`top`/`bottom`), so the flip has both
	 * edges to work from.
	 */
	let {
		text,
		context,
		fetchFn,
		phase,
		x,
		top,
		bottom,
		onAdd,
		onAskMeaning,
		onClose,
	}: {
		text: string;
		context: string;
		fetchFn: typeof fetch;
		phase: 'actions' | 'meaning';
		x: number;
		top: number;
		bottom: number;
		onAdd: () => void;
		onAskMeaning: () => void;
		onClose: () => void;
	} = $props();

	let cardEl = $state<HTMLDivElement | null>(null);
	const reading = $derived(pinyin(text));

	// Gap between the word and the card, and the minimum breathing room kept from
	// the viewport edges.
	const GAP = 4;
	const MARGIN = 8;

	// The measured, viewport-clamped position. Null until the card has been laid
	// out once, so it stays hidden for the single frame before it can be placed
	// (no flash at the unclamped origin).
	let placement = $state<{ left: number; top: number } | null>(null);

	$effect(() => {
		if (!cardEl) return;
		// Re-measure when the anchor moves (a tap on a different word) or the card
		// resizes (the meaning streaming in, or actions -> meaning).
		void x;
		void top;
		void bottom;
		void phase;
		void meaning;
		void failed;
		const card = cardEl.getBoundingClientRect();
		const left = Math.min(
			Math.max(MARGIN, x - card.width / 2),
			window.innerWidth - card.width - MARGIN,
		);
		const fitsAbove = top - card.height - GAP >= MARGIN;
		const cardTop = fitsAbove ? top - card.height - GAP : bottom + GAP;
		placement = { left, top: cardTop };
	});

	let meaning = $state('');
	let failed = $state(false);

	$effect(() => {
		// Stream only once we are showing the meaning; re-run when the word changes
		// (a tap on a different word). Abort on dismiss, retap, or Escape.
		if (phase !== 'meaning') return;
		// A word glossed earlier this session shows instantly, no model call.
		const hit = cachedGloss(text, context);
		if (hit !== undefined) {
			meaning = hit;
			failed = false;
			return;
		}
		const controller = new AbortController();
		meaning = '';
		failed = false;
		streamGloss({
			fetchFn,
			word: text,
			context,
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
	class="fixed z-50"
	style="left: {placement?.left ?? x}px; top: {placement?.top ?? top}px; visibility: {placement
		? 'visible'
		: 'hidden'}"
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
