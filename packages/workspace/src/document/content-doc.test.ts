/**
 * Tests for `createContentDoc`: it stamps the composed guid onto the doc and
 * enables gc, and (at the type level) it refuses anything but a `DocGuid`.
 */

import { describe, expect, test } from 'bun:test';
import { createContentDoc } from './content-doc.js';
import { docGuid } from './doc-guid.js';

const guid = docGuid({
	workspaceId: 'epicenter-honeycrisp',
	collection: 'notes',
	rowId: 'k7x9m2p4q8',
	field: 'body',
});

describe('createContentDoc', () => {
	test('stamps the composed guid onto the doc', () => {
		const ydoc = createContentDoc(guid);
		expect(ydoc.guid).toBe(guid);
		ydoc.destroy();
	});

	test('enables gc (deleted content garbage-collects like any CRDT)', () => {
		const ydoc = createContentDoc(guid);
		expect(ydoc.gc).toBe(true);
		ydoc.destroy();
	});

	test('refuses a bare string: only a DocGuid composes a content doc', () => {
		// @ts-expect-error a raw string (or a row id) is not a DocGuid; the brand
		// is the whole point, turning "forgot to compose the guid" into a compile
		// error rather than a silent collision.
		createContentDoc('notes.k7x9m2p4q8');
	});
});
