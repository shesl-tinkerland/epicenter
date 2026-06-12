import { describe, expect, test } from 'bun:test';
import { parseModel, validateModel } from './model';

describe('validateModel (the matter.json gate)', () => {
	test('accepts the palette subset and derives kinds in declared order', () => {
		const { data, error } = validateModel({
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
		expect(data.unmodeled).toEqual([]);
		expect(data.unmatchedOptional).toEqual([]);
	});

	test('top-level optional marks typed fields as not required', () => {
		const { data, error } = validateModel({
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
		expect(validateModel({ fields: {}, optional: 'title' }).error?.name).toBe(
			'InvalidOptional',
		);
		expect(validateModel({ fields: {}, optional: [42] }).error?.name).toBe(
			'InvalidOptional',
		);
	});

	test('reports optional entries that do not match typed fields', () => {
		const { data, error } = validateModel({
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
		expect(data.unmodeled).toEqual(['meta']);
		expect(data.unmatchedOptional).toEqual(['meta', 'missing']);
	});

	test('rejects a non-object top level', () => {
		expect(validateModel(42).error?.name).toBe('NotAnObject');
		expect(validateModel(null).error?.name).toBe('NotAnObject');
		expect(validateModel([]).error?.name).toBe('NotAnObject');
	});

	test('rejects a missing fields object', () => {
		const { error } = validateModel({ views: {} });
		expect(error?.name).toBe('MissingFields');
		expect(error?.message).toMatch(/fields/);
	});

	// Per-field degrade: a field outside the palette does not error the model. It is
	// recorded in `unmodeled` (shown raw), and the rest of the folder stays typed.
	test('a non-object field is unmodeled, not a model error', () => {
		const { data, error } = validateModel({
			fields: { title: { type: 'string' }, bad: 'string' },
		});
		expect(error).toBeNull();
		if (error) throw new Error(error.message);
		expect(data.fields.map((c) => c.name)).toEqual(['title']);
		expect(data.unmodeled).toEqual(['bad']);
		expect(data.unmatchedOptional).toEqual([]);
	});

	test('a shape outside the palette is unmodeled; the rest stays typed', () => {
		const { data, error } = validateModel({
			fields: {
				title: { type: 'string' },
				meta: { type: 'object' }, // not a palette shape
				note: { anyOf: [{ type: 'string' }, { type: 'null' }] }, // nullable: deleted axis
			},
		});
		expect(error).toBeNull();
		if (error) throw new Error(error.message);
		expect(data.fields.map((c) => c.name)).toEqual(['title']);
		expect(data.unmodeled).toEqual(['meta', 'note']);
		expect(data.unmatchedOptional).toEqual([]);
	});
});

describe('parseModel (raw text)', () => {
	test('rejects invalid JSON with an error rather than throwing', () => {
		const { error } = parseModel('{ not json');
		expect(error?.name).toBe('InvalidJson');
		expect(error?.message).toMatch(/JSON/);
	});

	test('parses a valid file', () => {
		const { data, error } = parseModel(
			'{"fields":{"title":{"type":"string"}}}',
		);
		expect(error).toBeNull();
		expect(data?.fields).toHaveLength(1);
	});
});
