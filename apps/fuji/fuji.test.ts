/**
 * Tests for Fuji schema helpers that pin durable document identifiers.
 */

import { describe, expect, test } from 'bun:test';
import { asEntryId, entryContentDocGuid } from './fuji.workspace.js';

describe('Fuji schema helpers', () => {
	test('entryContentDocGuid is deterministic per entry id', () => {
		const a = entryContentDocGuid(asEntryId('entry-1'));
		const b = entryContentDocGuid(asEntryId('entry-1'));
		const c = entryContentDocGuid(asEntryId('entry-2'));
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(a.length).toBeGreaterThan(0);
	});
});
