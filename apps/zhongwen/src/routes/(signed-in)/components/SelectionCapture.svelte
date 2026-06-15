<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import PlusIcon from '@lucide/svelte/icons/plus';

	/**
	 * Highlight-to-add capture: select a stretch of Chinese inside the chat and a
	 * floating button offers to add it to the dictionary. Until CC-CEDICT
	 * segmentation (step 7) exists, an untracked run has no word boundaries to tap,
	 * so the learner draws the boundary with a text selection and we capture
	 * exactly what they picked. `onAdd` owns the dedup (re-adding an existing word
	 * is a no-op there), so this component only decides when to offer the button.
	 */
	let {
		root,
		onAdd,
	}: {
		root: HTMLElement | undefined;
		onAdd: (text: string) => void;
	} = $props();

	let capture = $state<{ text: string; x: number; y: number } | null>(null);

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
		if (!root.contains(range.commonAncestorContainer)) {
			capture = null;
			return;
		}
		const rect = range.getBoundingClientRect();
		capture = { text, x: rect.left + rect.width / 2, y: rect.top };
	}

	function add() {
		if (!capture) return;
		onAdd(capture.text);
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
		class="fixed z-50 -translate-x-1/2 -translate-y-full pb-1"
		style="left: {capture.x}px; top: {capture.y}px"
	>
		<!-- Keep the selection alive: a plain mousedown on the button would collapse
			it, firing selectionchange and unmounting this button before the click. -->
		<Button size="sm" onpointerdown={(event) => event.preventDefault()} onclick={add}>
			<PlusIcon class="size-3.5" />
			Add {capture.text}
		</Button>
	</div>
{/if}
