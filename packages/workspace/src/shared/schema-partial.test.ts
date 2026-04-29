/**
 * Unit tests for `partialUpdate`. Verifies arktype `.pick('id').and(...partial())`
 * produces the right runtime + compile-time shape (id required, rest optional,
 * brands preserved).
 */
import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import { partialUpdate } from './schema-partial.js';

type Brand<B extends string> = { readonly __brand: B };
type EntryId = string & Brand<'EntryId'>;

const EntryIdT = type('string').pipe((s): EntryId => s as EntryId);

const Entry = type({
	id: EntryIdT,
	_v: '"1"',
	title: 'string',
	tags: 'string[]',
});

describe('partialUpdate', () => {
	test('keeps `id` required and makes the rest optional', () => {
		const Patch = partialUpdate(Entry);

		expect(Patch({ id: 'x', title: 'a' }) instanceof type.errors).toBe(false);
		expect(Patch({ id: 'x', tags: ['t'] }) instanceof type.errors).toBe(false);
		expect(Patch({ id: 'x' }) instanceof type.errors).toBe(false);
	});

	test('rejects missing `id`', () => {
		const Patch = partialUpdate(Entry);
		expect(Patch({ title: 'no id' }) instanceof type.errors).toBe(true);
	});

	test('still validates wrong shape on optional fields', () => {
		const Patch = partialUpdate(Entry);
		// `_v` is a literal `"1"`; `99` should still fail even though optional.
		expect(Patch({ id: 'x', _v: 99 }) instanceof type.errors).toBe(true);
	});

	test('preserves the brand on the required field at the type level', () => {
		const Patch = partialUpdate(Entry);
		type Out = typeof Patch.infer;

		const _branded: EntryId = 'x' as EntryId;
		const _ok: Out = { id: _branded };
		_ok.title = 'a';
		_ok.tags = ['t'];

		// @ts-expect-error — bare string must not assign to a branded id output.
		const _bad: Out = { id: 'plain-string' };
		void _bad;
		expect(true).toBe(true);
	});
});
