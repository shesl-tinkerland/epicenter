<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import LanguagesIcon from '@lucide/svelte/icons/languages';
	import PlusIcon from '@lucide/svelte/icons/plus';

	/**
	 * Selection toolbar over the chat: select a short stretch of Chinese and a
	 * floating bar offers to add it to the dictionary or gloss it. The learner
	 * draws the boundary by selecting (there is no segmenter; selection is the
	 * capture- and gloss-unit), so a wrong pick is just re-selected or deleted.
	 * `onAdd` owns the dedup; `onGloss` opens the contextual meaning card.
	 */
	let {
		root,
		onAdd,
		onGloss,
	}: {
		root: HTMLElement | undefined;
		onAdd: (text: string) => void;
		onGloss: (gloss: {
			text: string;
			context: string;
			x: number;
			y: number;
		}) => void;
	} = $props();

	let capture = $state<{
		text: string;
		context: string;
		x: number;
		y: number;
	} | null>(null);

	// Offer capture only for a short, Han-script selection that lives inside the
	// chat (not the input or header). The cap keeps a stray paragraph-drag from
	// adding a sentence as a "word".
	const HAS_HAN = /\p{Script=Han}/u;
	const MAX_TERM_LENGTH = 12;

	function readSelection() {
		const selection = window.getSelection();
		if (!selection || selection.isCollapsed || !root) {
			capture = null;
			return;
		}
		const text = selection.toString().trim();
		if (!text || text.length > MAX_TERM_LENGTH || !HAS_HAN.test(text)) {
			capture = null;
			return;
		}
		const range = selection.getRangeAt(0);
		const container = range.commonAncestorContainer;
		if (!root.contains(container)) {
			capture = null;
			return;
		}
		// The sentence the selection sits in, so a gloss reads it in context. Only
		// assistant messages carry it; selecting elsewhere just glosses the word.
		const element =
			container instanceof Element ? container : container.parentElement;
		const context =
			element
				?.closest('[data-gloss-context]')
				?.getAttribute('data-gloss-context') ?? '';
		const rect = range.getBoundingClientRect();
		capture = { text, context, x: rect.left + rect.width / 2, y: rect.top };
	}

	function add() {
		if (!capture) return;
		onAdd(capture.text);
		clear();
	}

	function gloss() {
		if (!capture) return;
		onGloss(capture);
		clear();
	}

	function clear() {
		capture = null;
		window.getSelection()?.removeAllRanges();
	}
</script>

<svelte:document
	onpointerup={readSelection}
	onselectionchange={() => {
		const selection = window.getSelection();
		if (!selection || selection.isCollapsed) capture = null;
	}}
	onscrollcapture={() => (capture = null)}
/>

{#if capture}
	<div
		class="fixed z-50 flex -translate-x-1/2 -translate-y-full gap-1 pb-1"
		style="left: {capture.x}px; top: {capture.y}px"
	>
		<!-- Keep the selection alive: a plain mousedown on a button would collapse
			it, firing selectionchange and unmounting the bar before the click. -->
		<Button size="sm" onpointerdown={(event) => event.preventDefault()} onclick={add}>
			<PlusIcon class="size-3.5" />
			Add {capture.text}
		</Button>
		<Button
			size="sm"
			variant="secondary"
			onpointerdown={(event) => event.preventDefault()}
			onclick={gloss}
		>
			<LanguagesIcon class="size-3.5" />
			What's this?
		</Button>
	</div>
{/if}
