<script lang="ts">
	/**
	 * Headless selection detector for the chat: on pointerup, if the user selected
	 * a short Han-script run inside `root`, emit it (with the message it sits in) so
	 * the parent can float the word popover. Renders nothing and owns no dismissal:
	 * the popover owns its own lifecycle, which is what keeps a tap (a collapsed
	 * selection) from clearing a popover this detector never opened.
	 */
	let {
		root,
		onSelect,
	}: {
		root: HTMLElement | undefined;
		onSelect: (selection: {
			text: string;
			messageId: string | null;
			x: number;
			top: number;
			bottom: number;
		}) => void;
	} = $props();

	// A short, Han-script selection only: the cap stops a stray paragraph-drag from
	// being treated as a single "word".
	const HAS_HAN = /\p{Script=Han}/u;
	const MAX_TERM_LENGTH = 12;

	function readSelection() {
		const selection = window.getSelection();
		if (!selection || selection.isCollapsed || !root) return;
		const text = selection.toString().trim();
		if (!text || text.length > MAX_TERM_LENGTH || !HAS_HAN.test(text)) return;
		const range = selection.getRangeAt(0);
		const container = range.commonAncestorContainer;
		if (!root.contains(container)) return;
		const element =
			container instanceof Element ? container : container.parentElement;
		const messageId =
			element?.closest('[data-message-id]')?.getAttribute('data-message-id') ??
			null;
		const rect = range.getBoundingClientRect();
		onSelect({
			text,
			messageId,
			x: rect.left + rect.width / 2,
			top: rect.top,
			bottom: rect.bottom,
		});
	}
</script>

<svelte:document onpointerup={readSelection} />
