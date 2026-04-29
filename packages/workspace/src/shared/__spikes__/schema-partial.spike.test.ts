/**
 * Phase 4 spike: does arktype `.partial()` preserve branded id types?
 *
 * Goal: define `partialOf(schema, { keep: ['id'] })` for table action input
 * schemas. Need: required `id` (with brand preserved) plus optional rest.
 *
 * Verdict (2026-04-28): `schema.pick('id').and(schema.omit('id').partial())`
 * works directly. id stays required, rest go optional, wrong `_v` is still
 * rejected, and the EntryId brand survives on the inferred input type. No
 * custom walker needed; see the bottom of the file for the recommended
 * `partialOf` shape.
 */
import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';

// Mirror the brand pattern this repo uses for table ids (see apps/fuji EntryId).
type Brand<B extends string> = { readonly __brand: B };
type EntryId = string & Brand<'EntryId'>;

const EntryIdT = type('string').pipe((s): EntryId => s as EntryId);

const Entry = type({
	id: EntryIdT,
	_v: '"1"',
	title: 'string',
	tags: 'string[]',
});

describe('arktype .partial() spike', () => {
	test('plain .partial() drops required id', () => {
		const Patch = Entry.partial();
		expect(Patch({ id: 'x', title: 'a' }) instanceof type.errors).toBe(false);
		// id is now optional: an empty object is accepted (this is the bug).
		expect(Patch({}) instanceof type.errors).toBe(false);
	});

	test('pick(id).and(omit(id).partial()) keeps id required + brand', () => {
		const Required = Entry.pick('id');
		const Rest = Entry.omit('id').partial();
		const Patch = Required.and(Rest);

		// Runtime: id mandatory, others optional, _v shape still validated.
		const ok1 = Patch({ id: 'x', title: 'a' });
		const ok2 = Patch({ id: 'x', tags: ['t'] });
		const ok3 = Patch({ id: 'x' });
		const noId = Patch({ title: 'no id' });
		const wrongV = Patch({ id: 'x', _v: 99 });

		expect(ok1 instanceof type.errors).toBe(false);
		expect(ok2 instanceof type.errors).toBe(false);
		expect(ok3 instanceof type.errors).toBe(false);
		expect(noId instanceof type.errors).toBe(true);
		expect(wrongV instanceof type.errors).toBe(true);

		// Compile-time: brand on `id` survives the pick/and chain.
		type In = typeof Patch.infer;
		const _branded: EntryId = 'x' as EntryId;
		const _check: In = { id: _branded };
		_check.title = 'a';
		_check.tags = ['t'];
		// @ts-expect-error — bare string must not assign to branded id input.
		const _bad: In = { id: 'plain-string' };
		void _bad;
		expect(true).toBe(true);
	});
});

/**
 * VERDICT (2026-04-28):
 *
 * `Entry.pick('id').and(Entry.omit('id').partial())` works directly. Arktype:
 *   - keeps `id` required at runtime (rejects `{ title: 'no id' }`),
 *   - allows missing optional keys (`{ id }` alone parses),
 *   - still validates literal/wrong shapes on optional keys when present
 *     (`{ id, _v: 99 }` rejected because `_v: '"1"'` is the version literal),
 *   - preserves the EntryId brand on the inferred input type because `pick`
 *     carries the `.pipe(...)` morph through unchanged, and `.and()` merges
 *     property morphs without erasing them.
 *
 * Recommendation for `partialOf(schema, { keep })`:
 *
 *   export function partialOf<S, K extends keyof S['infer']>(
 *     schema: S, opts: { keep: readonly K[] },
 *   ) {
 *     return schema.pick(...opts.keep).and(schema.omit(...opts.keep).partial());
 *   }
 *
 * Phase 4 should use arktype directly. No custom walker needed.
 */
