import { describe, expect, test } from 'bun:test';
import { parseContract, validateContract } from './contract';

describe('validateContract (the matter.json gate)', () => {
	test('accepts the palette subset and derives kinds in declared order', () => {
		const { data, error } = validateContract({
			fields: {
				title: { type: 'string' },
				status: { type: 'string', enum: ['draft', 'published'] },
				labels: { type: 'array', items: { enum: ['red', 'green'] } },
				tags: { type: 'array', items: { type: 'string' } },
				url: { type: 'string', format: 'uri' },
			},
		});
		expect(error).toBeNull();
		if (error) throw new Error(error.message);
		expect(data.fields.map((c) => [c.name, c.kind])).toEqual([
			['title', 'string'],
			['status', 'select'],
			['labels', 'multiSelect'],
			['tags', 'tags'],
			['url', 'url'],
		]);
		expect(data.fields.map((c) => [c.name, c.required])).toEqual([
			['title', true],
			['status', true],
			['labels', true],
			['tags', true],
			['url', true],
		]);
		expect(data.untyped).toEqual([]);
		expect(data.unmatchedOptional).toEqual([]);
	});

	test('top-level optional marks typed fields as not required', () => {
		const { data, error } = validateContract({
			fields: {
				title: { type: 'string' },
				publishDate: { type: 'string', format: 'date' },
			},
			optional: ['publishDate'],
		});
		expect(error).toBeNull();
		if (error) throw new Error(error.message);
		expect(data.fields.map((c) => [c.name, c.required])).toEqual([
			['title', true],
			['publishDate', false],
		]);
		expect(data.unmatchedOptional).toEqual([]);
	});

	test('rejects optional when it is not an array of field names', () => {
		expect(
			validateContract({ fields: {}, optional: 'title' }).error?.name,
		).toBe('InvalidOptional');
		expect(validateContract({ fields: {}, optional: [42] }).error?.name).toBe(
			'InvalidOptional',
		);
	});

	test('reports optional entries that do not match typed fields', () => {
		const { data, error } = validateContract({
			fields: {
				title: { type: 'string' },
				meta: { type: 'object' },
			},
			optional: ['title', 'meta', 'missing'],
		});
		expect(error).toBeNull();
		if (error) throw new Error(error.message);
		expect(data.fields.map((c) => [c.name, c.required])).toEqual([
			['title', false],
		]);
		expect(data.untyped).toEqual(['meta']);
		expect(data.unmatchedOptional).toEqual(['meta', 'missing']);
	});

	test('rejects a non-object top level', () => {
		expect(validateContract(42).error?.name).toBe('NotAnObject');
		expect(validateContract(null).error?.name).toBe('NotAnObject');
		expect(validateContract([]).error?.name).toBe('NotAnObject');
	});

	// No `fields` map is no longer a contract error: it is the untyped marker, classified by
	// `parseContract`. As a typed contract a fields-less object is simply zero declared fields.
	test('an object with no fields map is a zero-field contract, not an error', () => {
		const { data, error } = validateContract({ views: {} });
		expect(error).toBeNull();
		if (error) throw new Error(error.message);
		expect(data.fields).toEqual([]);
		expect(data.untyped).toEqual([]);
	});

	// Per-field degrade: a field outside the palette does not error the contract. It is
	// recorded in `untyped` (shown raw), and the rest of the folder stays typed.
	test('a non-object field is untyped, not a contract error', () => {
		const { data, error } = validateContract({
			fields: { title: { type: 'string' }, bad: 'string' },
		});
		expect(error).toBeNull();
		if (error) throw new Error(error.message);
		expect(data.fields.map((c) => c.name)).toEqual(['title']);
		expect(data.untyped).toEqual(['bad']);
		expect(data.unmatchedOptional).toEqual([]);
	});

	test('a shape outside the palette is untyped; the rest stays typed', () => {
		const { data, error } = validateContract({
			fields: {
				title: { type: 'string' },
				meta: { type: 'object' }, // not a palette shape
				note: { anyOf: [{ type: 'string' }, { type: 'null' }] }, // nullable: deleted axis
			},
		});
		expect(error).toBeNull();
		if (error) throw new Error(error.message);
		expect(data.fields.map((c) => c.name)).toEqual(['title']);
		expect(data.untyped).toEqual(['meta', 'note']);
		expect(data.unmatchedOptional).toEqual([]);
	});
});

describe('parseContract (raw text classifies the marker)', () => {
	test('invalid JSON is an error rather than a throw', () => {
		const parsed = parseContract('{ not json');
		expect(parsed.kind).toBe('error');
		if (parsed.kind !== 'error') throw new Error('expected error');
		expect(parsed.error.name).toBe('InvalidJson');
		expect(parsed.error.message).toMatch(/JSON/);
	});

	test('a non-object top level is an error (a claimed but broken contract)', () => {
		const parsed = parseContract('42');
		expect(parsed.kind).toBe('error');
		if (parsed.kind !== 'error') throw new Error('expected error');
		expect(parsed.error.name).toBe('NotAnObject');
	});

	test('an empty object {} is the untyped marker, not an error', () => {
		expect(parseContract('{}').kind).toBe('untyped');
		// Any object lacking a `fields` map is the same untyped marker.
		expect(parseContract('{"views":{}}').kind).toBe('untyped');
	});

	test('a non-empty fields map is a typed contract, distinct from the {} marker', () => {
		const parsed = parseContract('{"fields":{"title":{"type":"string"}}}');
		expect(parsed.kind).toBe('typed');
		if (parsed.kind !== 'typed') throw new Error('expected typed');
		expect(parsed.contract.fields).toHaveLength(1);
	});

	test('an empty fields map {"fields":{}} is untyped, same as {}', () => {
		// Empty `fields` declares no schema, so it is the untyped raw grid, not a strict
		// zero-field table: the `{}`-vs-`{"fields":{}}` flip (permissive vs strict) was a footgun.
		expect(parseContract('{"fields":{}}').kind).toBe('untyped');
	});
});
