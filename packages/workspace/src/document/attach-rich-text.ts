/**
 * attachRichText(): Bind a `Y.XmlFragment` slot on a Y.Doc to a typed handle.
 *
 * Reserves `ydoc.getXmlFragment(key)` and hands back `{ binding, read, write }`.
 * The `binding` is what you feed into a ProseMirror/Tiptap Yjs extension; `read`
 * flattens the fragment to plain text (block-aware: paragraphs, headings, and
 * other block elements produce newlines between them); `write` replaces the
 * fragment with a single paragraph of plain text (useful for programmatic
 * seed/reset, not for editor input: the editor mutates `binding` directly).
 *
 * Handle-style attachment: synchronous, no async teardown. Destroying the
 * `Y.Doc` releases the fragment along with the rest of the doc.
 *
 * @example
 * ```ts
 * const ydoc = new Y.Doc({ guid: 'note-1', gc: true });
 * const content = attachRichText(ydoc);
 * content.write('Hello');           // programmatic seed
 * tiptapEditor.use(ySyncPlugin(content.binding)); // editor-driven edits
 * ```
 */
import * as Y from 'yjs';

/**
 * Attach a rich-text handle to `ydoc` at `key` (default `'content'`).
 *
 * @param ydoc - Y.Doc to attach to
 * @param key  - Name of the `Y.XmlFragment` slot on the doc
 */
export function attachRichText(ydoc: Y.Doc, key = 'content') {
	const fragment = ydoc.getXmlFragment(key);
	return {
		/** `Y.XmlFragment`: pass this to a ProseMirror/Tiptap Yjs binding. */
		binding: fragment,
		/** Flatten the fragment to plain text with block-aware newlines. */
		read() {
			return xmlFragmentToPlaintext(fragment);
		},
		/** Replace the fragment with a single paragraph containing `text`. */
		write(text: string) {
			ydoc.transact(() => {
				while (fragment.length > 0) {
					fragment.delete(0, 1);
				}
				const paragraph = new Y.XmlElement('paragraph');
				paragraph.insert(0, [new Y.XmlText(text)]);
				fragment.insert(0, [paragraph]);
			});
		},
	};
}

export type RichTextAttachment = ReturnType<typeof attachRichText>;

/**
 * Block-level element names that produce line breaks in plaintext extraction.
 * Based on Tiptap/ProseMirror defaults.
 */
const BLOCK_ELEMENTS = new Set([
	'paragraph',
	'heading',
	'blockquote',
	'listItem',
	'bulletList',
	'orderedList',
	'codeBlock',
	'horizontalRule',
	'tableRow',
]);

/**
 * Extract plaintext from a Y.XmlFragment.
 *
 * Walks the tree recursively, collecting text from Y.XmlText nodes. Block-level
 * elements produce a newline between them so paragraphs don't smash together:
 * `<paragraph>Hello</paragraph><paragraph>World</paragraph>` returns `"Hello\nWorld"`.
 */
export function xmlFragmentToPlaintext(fragment: Y.XmlFragment): string {
	const parts: string[] = [];
	collectPlaintext(fragment, parts);
	return parts.join('');
}

function collectPlaintext(
	node: Y.XmlFragment | Y.XmlElement,
	parts: string[],
): void {
	const children = node.toArray();
	for (let i = 0; i < children.length; i++) {
		const child = children[i];

		if (child instanceof Y.XmlText) {
			parts.push(child.toString());
		} else if (child instanceof Y.XmlElement) {
			const isBlock = BLOCK_ELEMENTS.has(child.nodeName);

			collectPlaintext(child, parts);

			// Newline after block elements, skipping the last to avoid trailing \n
			if (isBlock && i < children.length - 1) {
				parts.push('\n');
			}
		}
	}
}
