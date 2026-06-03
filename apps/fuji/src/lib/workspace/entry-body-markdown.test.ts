/**
 * Tests for the entry-body markdown serializer (the read half of the
 * projection). Each case builds a ProseMirror doc with `entryBodySchema`, loads
 * it into a fresh Yjs XmlFragment via `prosemirrorToYXmlFragment`, then
 * serializes that fragment back to markdown the way the daemon materializer
 * does. There is no parse half to round-trip against: the projection is
 * read-only.
 */

import { describe, expect, test } from 'bun:test';
import type { Node } from 'prosemirror-model';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';
import * as Y from 'yjs';
import { serializeEntryBody } from './entry-body-markdown.js';
import { entryBodySchema as schema } from './entry-body-schema.js';

/** Serialize a ProseMirror doc node through a real Yjs fragment round trip. */
function serialize(doc: Node): string {
	const fragment = new Y.Doc().getXmlFragment('content');
	prosemirrorToYXmlFragment(doc, fragment);
	return serializeEntryBody(fragment);
}

// `schema.node(name, ...)` / `schema.mark(name)` avoid indexing `schema.nodes`,
// which is `NodeType | undefined` under noUncheckedIndexedAccess.
const doc = (...content: Node[]): Node => schema.node('doc', null, content);
const paragraph = (...content: Node[]): Node =>
	schema.node('paragraph', null, content);

describe('serializeEntryBody', () => {
	test('renders a heading', () => {
		const node = doc(
			schema.node('heading', { level: 2 }, schema.text('Title')),
		);
		expect(serialize(node)).toBe('## Title');
	});

	test('renders strong and em marks', () => {
		const node = doc(
			paragraph(
				schema.text('bold', [schema.mark('strong')]),
				schema.text(' and '),
				schema.text('italic', [schema.mark('em')]),
			),
		);
		expect(serialize(node)).toBe('**bold** and *italic*');
	});

	test('renders the underline mark as <u> html', () => {
		const node = doc(
			paragraph(schema.text('underlined', [schema.mark('underline')])),
		);
		expect(serialize(node)).toBe('<u>underlined</u>');
	});

	test('renders the strikethrough mark as ~~', () => {
		const node = doc(
			paragraph(schema.text('gone', [schema.mark('strikethrough')])),
		);
		expect(serialize(node)).toBe('~~gone~~');
	});

	test('renders a bullet list', () => {
		const item = (text: string) =>
			schema.node('list_item', null, paragraph(schema.text(text)));
		const node = doc(
			schema.node('bullet_list', null, [item('first'), item('second')]),
		);
		const md = serialize(node);
		expect(md).toContain('* first');
		expect(md).toContain('* second');
	});

	test('renders an ordered list', () => {
		const item = (text: string) =>
			schema.node('list_item', null, paragraph(schema.text(text)));
		const node = doc(
			schema.node('ordered_list', { order: 1 }, [item('one'), item('two')]),
		);
		const md = serialize(node);
		expect(md).toContain('1. one');
		expect(md).toContain('2. two');
	});

	test('renders a blockquote', () => {
		const node = doc(
			schema.node('blockquote', null, paragraph(schema.text('quoted'))),
		);
		expect(serialize(node)).toBe('> quoted');
	});

	test('renders a code block', () => {
		const node = doc(
			schema.node('code_block', null, schema.text('const x = 1;')),
		);
		expect(serialize(node)).toBe('```\nconst x = 1;\n```');
	});

	test('serializes an empty body to an empty string', () => {
		const node = doc(paragraph());
		expect(serialize(node)).toBe('');
	});
});
