/**
 * attachPlainText(): Bind a `Y.Text` slot on a Y.Doc to a typed handle.
 *
 * Reserves `ydoc.getText(key)` and hands back `{ binding, read, write }`.
 * The `binding` is what you feed into a CodeMirror/Monaco Yjs extension; `read`
 * returns the current string; `write` replaces the entire `Y.Text` in a single
 * transaction (programmatic seed/reset: editors mutate `binding` directly).
 *
 * Handle-style attachment: synchronous, no async teardown. Destroying the
 * `Y.Doc` releases the text slot along with the rest of the doc.
 *
 * @example
 * ```ts
 * const ydoc = new Y.Doc({ guid: 'snippet-1', gc: true });
 * const code = attachPlainText(ydoc);
 * code.write('console.log(1)');
 * codemirror.use(yCollab(code.binding, awareness));
 * ```
 */
import type * as Y from 'yjs';

/**
 * Attach a plain-text handle to `ydoc` at `key` (default `'content'`).
 *
 * @param ydoc - Y.Doc to attach to
 * @param key  - Name of the `Y.Text` slot on the doc
 */
export function attachPlainText(ydoc: Y.Doc, key = 'content') {
	const ytext = ydoc.getText(key);
	return {
		/** `Y.Text`: pass this to a CodeMirror/Monaco Yjs binding. */
		binding: ytext,
		/** Read the current text as a string. */
		read() {
			return ytext.toString();
		},
		/** Replace the entire Y.Text with `text` in a single transaction. */
		write(text: string) {
			ydoc.transact(() => {
				ytext.delete(0, ytext.length);
				ytext.insert(0, text);
			});
		},
	};
}

export type PlainTextAttachment = ReturnType<typeof attachPlainText>;
