/**
 * Tests for Honeycrisp schema helpers that pin durable document identifiers.
 */

import { describe, expect, test } from 'bun:test';
import { asNoteId, noteBodyDocGuid } from './honeycrisp.js';

describe('Honeycrisp schema helpers', () => {
	test('noteBodyDocGuid is deterministic per note id', () => {
		const a = noteBodyDocGuid(asNoteId('note-1'));
		const b = noteBodyDocGuid(asNoteId('note-1'));
		const c = noteBodyDocGuid(asNoteId('note-2'));
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(a.length).toBeGreaterThan(0);
	});
});
