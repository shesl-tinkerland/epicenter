/**
 * Runtime tests for the `column.*` sugar layer. The compile-time tests live
 * in `column.test-d.ts`; this file verifies that the schemas the sugar
 * produces validate values correctly via `Value.Check`.
 */

import { describe, expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { column } from './index';

describe('column.string', () => {
	test('plain string validates strings', () => {
		const schema = column.string();
		expect(Value.Check(schema, 'hi')).toBe(true);
		expect(Value.Check(schema, 42)).toBe(false);
	});

	test('options propagate as JSON Schema keywords', () => {
		const schema = column.string({ minLength: 2 });
		expect(Value.Check(schema, 'hi')).toBe(true);
		expect(Value.Check(schema, 'x')).toBe(false);
	});
});

describe('column.literal', () => {
	test('matches the literal value', () => {
		const v1 = column.literal(1);
		expect(Value.Check(v1, 1)).toBe(true);
		expect(Value.Check(v1, 2)).toBe(false);
	});
});

describe('column.nullable', () => {
	test('accepts inner schema value or null', () => {
		const schema = column.nullable(column.string());
		expect(Value.Check(schema, 'hi')).toBe(true);
		expect(Value.Check(schema, null)).toBe(true);
		expect(Value.Check(schema, 42)).toBe(false);
	});
});

describe('column.enum', () => {
	test('accepts members, rejects others', () => {
		const status = column.enum(['draft', 'published']);
		expect(Value.Check(status, 'draft')).toBe(true);
		expect(Value.Check(status, 'published')).toBe(true);
		expect(Value.Check(status, 'archived')).toBe(false);
	});

	test('rejects empty value lists', () => {
		expect(() => column.enum([])).toThrow(
			'column.enum requires at least one value',
		);
	});
});

describe('column.json', () => {
	test('validates against the provided schema (type derives from schema)', () => {
		const tagsSchema = column.json(column.string());
		// Runtime validation delegates to the inner schema; the static type
		// is `Static<typeof inner>` so type and runtime cannot drift.
		expect(Value.Check(tagsSchema, 'hello')).toBe(true);
		expect(Value.Check(tagsSchema, 42)).toBe(false);
	});
});

describe('column.dateTime', () => {
	const schema = column.dateTime();

	test('accepts RFC 3339 Z form', () => {
		expect(Value.Check(schema, '2024-01-01T20:00:00.000Z')).toBe(true);
	});

	test('accepts RFC 3339 with offset', () => {
		expect(Value.Check(schema, '2024-01-01T15:00:00.000-05:00')).toBe(true);
	});

	test('rejects malformed strings', () => {
		expect(Value.Check(schema, 'not a date')).toBe(false);
		expect(Value.Check(schema, '2024-01-01')).toBe(false);
	});
});

describe('column.ianaTimeZone', () => {
	const schema = column.ianaTimeZone();

	test('accepts valid IANA zones', () => {
		expect(Value.Check(schema, 'America/New_York')).toBe(true);
		expect(Value.Check(schema, 'UTC')).toBe(true);
	});

	test('rejects invalid zones', () => {
		expect(Value.Check(schema, 'Not/A_Zone')).toBe(false);
		expect(Value.Check(schema, '')).toBe(false);
	});
});

describe('column.array', () => {
	test('validates a list of the inner schema', () => {
		const schema = column.array(column.string());
		expect(Value.Check(schema, ['page_a', 'page_b'])).toBe(true);
		expect(Value.Check(schema, [])).toBe(true);
		expect(Value.Check(schema, [42])).toBe(false);
		expect(Value.Check(schema, 'page_a')).toBe(false);
	});
});

describe('column.array survives a JSON / Yjs round-trip', () => {
	// A ColumnSpec.schema is stored verbatim in Yjs as JSON and re-validated with
	// Value.Check after the round-trip. These schemas are plain JSON Schema (no
	// `[Kind]` symbols), so a structured-clone / JSON pass must validate
	// identically: this is what lets column.array(column.string()) live inside a
	// tag's stored columns. A reference is just a string holding an `epicenter://`
	// URN; the projector recognizes it by value, never a schema marker.
	test('column.array(column.string()) round-trips and validates identically', () => {
		const original = column.array(column.string());
		const roundTripped = JSON.parse(JSON.stringify(original));
		expect(roundTripped).toEqual({
			type: 'array',
			items: { type: 'string' },
		});
		expect(Value.Check(roundTripped, ['page_a', 'page_b'])).toBe(true);
		expect(Value.Check(roundTripped, [1, 2])).toBe(false);
	});
});
