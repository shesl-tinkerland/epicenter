/**
 * Markdown serializer for a fuji entry body: ProseMirror -> markdown (the read
 * half of the projection). There is no parse half: the materialized `.md` is a
 * read-only projection of Yjs, never reconciled back, so the body has no
 * round-trip obligation and the inverse markdown -> ProseMirror parser was
 * deleted with the bidirectional subsystem.
 *
 * Reads an entry's rich-text Yjs fragment as a ProseMirror doc and writes
 * markdown that preserves headings, lists, blockquotes, code blocks, and marks
 * (instead of flattening to plaintext).
 */

import {
	defaultMarkdownSerializer,
	MarkdownSerializer,
} from 'prosemirror-markdown';
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import type * as Y from 'yjs';
import { entryBodySchema } from './entry-body-schema';

// defaultMarkdownSerializer covers schema-basic + schema-list nodes/marks
// (paragraph, heading, blockquote, code_block, lists, em, strong, link, code,
// image, hard_break). Extend the marks with fuji's two custom marks. Underline
// has no CommonMark form, so render it as the <u> HTML the editor already emits.
const serializer = new MarkdownSerializer(defaultMarkdownSerializer.nodes, {
	...defaultMarkdownSerializer.marks,
	strikethrough: {
		open: '~~',
		close: '~~',
		mixable: true,
		expelEnclosingWhitespace: true,
	},
	underline: { open: '<u>', close: '</u>', mixable: true },
});

export function serializeEntryBody(fragment: Y.XmlFragment): string {
	return serializer.serialize(
		yXmlFragmentToProseMirrorRootNode(fragment, entryBodySchema),
	);
}
