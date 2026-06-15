<script lang="ts">
	import type { Vocabulary } from '@epicenter/zhongwen';
	import DOMPurify from 'dompurify';
	import { marked } from 'marked';
	import { highlightVocabHtml } from '$lib/lens/highlight';
	import { annotateHtml } from '$lib/pinyin/annotate';

	/**
	 * Render one message body with the lens stacked on top: parse (assistant lines
	 * are markdown; the learner's are literal, so escape rather than parse) ->
	 * vocab highlight -> pinyin -> sanitize. The same path runs for both roles, so a
	 * word the learner typed is highlighted and tappable too, which is how their
	 * production shows up in the chat (not just the AI's recognition lines).
	 */
	type Props = {
		content: string;
		markdown: boolean;
		showPinyin: boolean;
		highlightVocab: boolean;
		words: Vocabulary[];
	};

	let { content, markdown, showPinyin, highlightVocab, words }: Props = $props();

	const PURIFY_CONFIG = {
		ADD_TAGS: ['ruby', 'rt', 'rp'],
	};

	// Highlight before pinyin: the vocab matcher needs whole CJK terms, so it must
	// run before annotateHtml splits each character into a <ruby>. Pinyin then
	// annotates the text inside each highlight span.
	const html = $derived.by(() => {
		const base = markdown
			? (marked.parse(content, { breaks: true, gfm: true }) as string)
			: escapeHtml(content);
		const highlighted = highlightVocab ? highlightVocabHtml(base, words) : base;
		const annotated = showPinyin ? annotateHtml(highlighted) : highlighted;
		return DOMPurify.sanitize(annotated, PURIFY_CONFIG);
	});

	/** Escape literal user text so a stray `<` is shown, not parsed as a tag. */
	function escapeHtml(value: string): string {
		return value
			.replaceAll('&', '&amp;')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;');
	}
</script>

<div class="prose prose-sm">{@html html}</div>
