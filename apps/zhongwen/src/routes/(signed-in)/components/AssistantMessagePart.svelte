<script lang="ts">
	import type { Vocabulary } from '@epicenter/zhongwen';
	import DOMPurify from 'dompurify';
	import { marked } from 'marked';
	import { highlightVocabHtml } from '$lib/lens/highlight';
	import { annotateHtml } from '$lib/pinyin/annotate';

	type Props = {
		content: string;
		showPinyin: boolean;
		highlightVocab: boolean;
		words: Vocabulary[];
	};

	let { content, showPinyin, highlightVocab, words }: Props = $props();

	const PURIFY_CONFIG = {
		ADD_TAGS: ['ruby', 'rt', 'rp'],
	};

	// Highlight before pinyin: the vocab matcher needs whole CJK terms, so it must
	// run before annotateHtml splits each character into a <ruby>. Pinyin then
	// annotates the text inside each highlight span.
	const html = $derived.by(() => {
		const raw = marked.parse(content, { breaks: true, gfm: true }) as string;
		const highlighted = highlightVocab ? highlightVocabHtml(raw, words) : raw;
		const annotated = showPinyin ? annotateHtml(highlighted) : highlighted;
		return DOMPurify.sanitize(annotated, PURIFY_CONFIG);
	});
</script>

<!-- data-gloss-context carries the raw message so a tapped word can be glossed in
	its sentence; the lens spans inside resolve it via closest(). -->
<div class="prose prose-sm" data-gloss-context={content}>{@html html}</div>
