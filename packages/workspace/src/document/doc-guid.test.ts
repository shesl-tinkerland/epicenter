/**
 * Tests for the content-doc guid grammar: collision-freedom (injectivity),
 * parsing unambiguity (exactly four recoverable segments), the segment
 * alphabet contract, and the `isDocGuid` boundary validator staying in lockstep
 * with what `docGuid` mints.
 */

import { describe, expect, test } from 'bun:test';
import { generateId } from '../shared/id.js';
import { DOC_GUID_SEGMENTS, docGuid, isDocGuid } from './doc-guid.js';

const tuple = {
	workspaceId: 'epicenter-honeycrisp',
	collection: 'notes',
	rowId: 'k7x9m2p4q8',
	field: 'body',
};

describe('docGuid', () => {
	test('composes the canonical four-part dotted form', () => {
		// Widen to `string` for the byte-exact check: the `DocGuid` brand makes
		// `toBe` reject a raw string literal, which is the brand doing its job.
		expect(String(docGuid(tuple))).toBe(
			'epicenter-honeycrisp.notes.k7x9m2p4q8.body',
		);
	});

	test('is deterministic: same tuple -> same guid', () => {
		expect(docGuid(tuple)).toBe(docGuid(tuple));
	});

	test('emits exactly DOC_GUID_SEGMENTS segments (parsing is unambiguous)', () => {
		// Hyphens live inside segments; only dots separate them. So a guid built
		// from hyphen-bearing segments still splits into exactly four parts.
		expect(docGuid(tuple).split('.')).toHaveLength(DOC_GUID_SEGMENTS);
	});
});

describe('docGuid injectivity (no two tuples collide)', () => {
	test('distinct tuples produce distinct guids', () => {
		const guids = [
			docGuid(tuple),
			docGuid({ ...tuple, collection: 'folders' }),
			docGuid({ ...tuple, rowId: 'aaaaaaaaaa' }),
			docGuid({ ...tuple, workspaceId: 'epicenter-fuji' }),
			// `field` is the segment that lets one row own two sibling child docs:
			// same workspace/collection/row, different field -> distinct guids.
			docGuid({ ...tuple, field: 'preview' }),
		];
		expect(new Set(guids).size).toBe(guids.length);
	});

	test('two child docs on the same row stay distinct via field', () => {
		const body = docGuid({ ...tuple, field: 'body' });
		const preview = docGuid({ ...tuple, field: 'preview' });
		expect(body).not.toBe(preview);
	});

	test('a hyphen boundary cannot masquerade as a segment boundary', () => {
		// `a-b . c` and `a . b-c` differ only in where the hyphen vs dot falls.
		// Because hyphen is never the separator, these stay distinct guids and
		// each still parses back to its own tuple.
		const left = docGuid({ ...tuple, workspaceId: 'a-b', collection: 'c' });
		const right = docGuid({ ...tuple, workspaceId: 'a', collection: 'b-c' });
		expect(left).not.toBe(right);
		expect(left.split('.')).toHaveLength(DOC_GUID_SEGMENTS);
		expect(right.split('.')).toHaveLength(DOC_GUID_SEGMENTS);
	});

	test('property: every generated rowId yields a four-segment guid', () => {
		for (let i = 0; i < 1000; i++) {
			const guid = docGuid({ ...tuple, rowId: generateId() });
			expect(guid.split('.')).toHaveLength(DOC_GUID_SEGMENTS);
			expect(isDocGuid(guid)).toBe(true);
		}
	});
});

describe('docGuid rejects unsafe segments (the delimiter invariant)', () => {
	test.each([
		['dot in a segment', { collection: 'no.tes' }],
		['slash in a segment', { rowId: 'a/b' }],
		['colon in a segment', { rowId: 'a:b' }],
		['uppercase', { collection: 'Notes' }],
		['leading hyphen', { collection: '-notes' }],
		['trailing hyphen', { collection: 'notes-' }],
		['double hyphen', { collection: 'no--tes' }],
		['empty segment', { rowId: '' }],
		['dot in the field segment', { field: 'bo.dy' }],
		['windows reserved name', { collection: 'con' }],
	])('throws on %s', (_label, override) => {
		expect(() => docGuid({ ...tuple, ...override })).toThrow();
	});
});

describe('isDocGuid (boundary validator)', () => {
	test('accepts exactly what docGuid mints', () => {
		expect(isDocGuid(docGuid(tuple))).toBe(true);
	});

	test.each([
		['three segments', 'epicenter-honeycrisp.notes.k7x9m2p4q8'],
		['five segments', 'epicenter-honeycrisp.notes.k7x9m2p4q8.body.extra'],
		['empty string', ''],
		['trailing dot (empty final segment)', 'a.b.c.'],
		['uppercase segment', 'epicenter-honeycrisp.Notes.k7x9m2p4q8.body'],
		['slash in a segment', 'a.b.c/d.e'],
		['windows reserved segment', 'a.con.c.d'],
	])('rejects %s', (_label, value) => {
		expect(isDocGuid(value)).toBe(false);
	});
});
