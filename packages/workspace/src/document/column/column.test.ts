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

describe('column.ref', () => {
	const schema = column.ref();

	test('validates a reference as a plain string', () => {
		expect(Value.Check(schema, 'page_abc')).toBe(true);
		expect(Value.Check(schema, 'epicenter://whispering/recordings/rec_1')).toBe(
			true,
		);
		expect(Value.Check(schema, 42)).toBe(false);
	});

	test('carries the x-epicenter-ref keyword so a projector can recognize it', () => {
		expect((schema as unknown as Record<string, unknown>)['x-epicenter-ref']).toBe(
			true,
		);
		// NOT `format`: a ref is a slug or URN, not a URI, and a custom keyword is
		// never touched by the validator (refs stay free to dangle).
		expect((schema as { format?: string }).format).toBeUndefined();
	});

	test('a dangling reference still validates (references may dangle, never block a write)', () => {
		expect(Value.Check(schema, 'page_does_not_exist_yet')).toBe(true);
	});
});

describe('column.array', () => {
	test('validates a list of the inner schema', () => {
		const schema = column.array(column.ref());
		expect(Value.Check(schema, ['page_a', 'page_b'])).toBe(true);
		expect(Value.Check(schema, [])).toBe(true);
		expect(Value.Check(schema, [42])).toBe(false);
		expect(Value.Check(schema, 'page_a')).toBe(false);
	});
});

describe('column.ref / column.array survive a JSON / Yjs round-trip', () => {
	// A ColumnSpec.schema is stored verbatim in Yjs as JSON and re-validated with
	// Value.Check after the round-trip. These schemas are plain JSON Schema (no
	// `[Kind]` symbols), so a structured-clone / JSON pass must validate
	// identically: this is what lets column.ref() and column.array(column.ref())
	// live inside a tag's stored columns.
	test('column.ref() round-trips and validates identically', () => {
		const original = column.ref();
		const roundTripped = JSON.parse(JSON.stringify(original));
		expect(roundTripped).toEqual({ type: 'string', 'x-epicenter-ref': true });
		expect(Value.Check(roundTripped, 'page_abc')).toBe(true);
		expect(Value.Check(roundTripped, 7)).toBe(false);
	});

	test('column.array(column.ref()) round-trips and validates identically', () => {
		const original = column.array(column.ref());
		const roundTripped = JSON.parse(JSON.stringify(original));
		expect(roundTripped).toEqual({
			type: 'array',
			items: { type: 'string', 'x-epicenter-ref': true },
		});
		expect(Value.Check(roundTripped, ['page_a', 'page_b'])).toBe(true);
		expect(Value.Check(roundTripped, [1, 2])).toBe(false);
	});
});
