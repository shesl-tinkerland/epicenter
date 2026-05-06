import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import {
	attachRichText,
	xmlFragmentToPlaintext,
} from './attach-rich-text.js';

/** Helper: build a paragraph XmlElement with text content (standalone, for insertion). */
function makeParagraph(content: string): Y.XmlElement {
	const p = new Y.XmlElement('paragraph');
	const t = new Y.XmlText();
	t.insert(0, content);
	p.insert(0, [t]);
	return p;
}

/** Helper: create a doc-backed XmlFragment via builder callback. */
function createDocFragment(
	build?: (fragment: Y.XmlFragment) => void,
): Y.XmlFragment {
	const doc = new Y.Doc();
	const fragment = doc.getXmlFragment('test');
	build?.(fragment);
	return fragment;
}

// ════════════════════════════════════════════════════════════════════════════
// attachRichText
// ════════════════════════════════════════════════════════════════════════════

describe('attachRichText', () => {
	test('reserves the default "content" key', () => {
		const ydoc = new Y.Doc();
		const { binding } = attachRichText(ydoc);

		expect(binding).toBe(ydoc.getXmlFragment('content'));
	});

	test('honors a custom key', () => {
		const ydoc = new Y.Doc();
		const { binding } = attachRichText(ydoc, 'body');

		expect(binding).toBe(ydoc.getXmlFragment('body'));
	});

	test('read() returns empty string when fresh', () => {
		const ydoc = new Y.Doc();
		const { read } = attachRichText(ydoc);

		expect(read()).toBe('');
	});

	test('write() replaces fragment with a single paragraph containing the text', () => {
		const ydoc = new Y.Doc();
		const { binding, read, write } = attachRichText(ydoc);
		write('hello');

		expect(read()).toBe('hello');
		expect(binding.length).toBe(1);
		const para = binding.get(0) as Y.XmlElement;
		expect(para.nodeName).toBe('paragraph');
	});

	test('write() replaces prior content rather than appending', () => {
		const ydoc = new Y.Doc();
		const { binding, read, write } = attachRichText(ydoc);
		write('first');
		write('second');

		expect(read()).toBe('second');
		expect(binding.length).toBe(1);
	});

	test('write() runs inside a single transaction', () => {
		const ydoc = new Y.Doc();
		const { write, binding } = attachRichText(ydoc);
		binding.insert(0, [makeParagraph('seed')]);

		let txCount = 0;
		ydoc.on('afterTransaction', () => {
			txCount++;
		});

		write('replacement');

		// clear + insert happen in one transaction.
		expect(txCount).toBe(1);
	});

	test('different keys on the same ydoc produce different bindings', () => {
		const ydoc = new Y.Doc();
		const a = attachRichText(ydoc, 'a');
		const b = attachRichText(ydoc, 'b');

		expect(a.binding).not.toBe(b.binding);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// xmlFragmentToPlaintext (block-aware extractor)
// ════════════════════════════════════════════════════════════════════════════

describe('xmlFragmentToPlaintext', () => {
	test('empty fragment returns empty string', () => {
		const fragment = createDocFragment();
		expect(xmlFragmentToPlaintext(fragment)).toBe('');
	});

	test('single paragraph', () => {
		const fragment = createDocFragment((f) => {
			f.insert(0, [makeParagraph('Hello world')]);
		});
		expect(xmlFragmentToPlaintext(fragment)).toBe('Hello world');
	});

	test('multiple paragraphs get newlines between them', () => {
		const fragment = createDocFragment((f) => {
			f.insert(0, [makeParagraph('First'), makeParagraph('Second')]);
		});
		expect(xmlFragmentToPlaintext(fragment)).toBe('First\nSecond');
	});

	test('heading elements get newlines', () => {
		const fragment = createDocFragment((f) => {
			const h = new Y.XmlElement('heading');
			const ht = new Y.XmlText();
			ht.insert(0, 'Title');
			h.insert(0, [ht]);
			f.insert(0, [h, makeParagraph('Body text')]);
		});
		expect(xmlFragmentToPlaintext(fragment)).toBe('Title\nBody text');
	});

	test('inline elements do not add newlines', () => {
		const fragment = createDocFragment((f) => {
			const p = new Y.XmlElement('paragraph');
			const t1 = new Y.XmlText();
			t1.insert(0, 'Hello ');
			const bold = new Y.XmlElement('bold');
			const t2 = new Y.XmlText();
			t2.insert(0, 'world');
			bold.insert(0, [t2]);
			p.insert(0, [t1, bold]);
			f.insert(0, [p]);
		});
		expect(xmlFragmentToPlaintext(fragment)).toBe('Hello world');
	});

	test('no trailing newline after last block', () => {
		const fragment = createDocFragment((f) => {
			f.insert(0, [makeParagraph('only')]);
		});
		const result = xmlFragmentToPlaintext(fragment);
		expect(result).toBe('only');
		expect(result.endsWith('\n')).toBe(false);
	});

	test('round-trip via attachRichText.write → xmlFragmentToPlaintext', () => {
		const ydoc = new Y.Doc();
		const { binding, write } = attachRichText(ydoc);
		write('round trip');

		expect(xmlFragmentToPlaintext(binding)).toBe('round trip');
	});
});
