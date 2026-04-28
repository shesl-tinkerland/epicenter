/**
 * Unit coverage for the pure helpers in `list.ts`. Renderer text output
 * and CLI argv plumbing are exercised end-to-end via the route tests in
 * `daemon/list-route.test.ts` and the command tests under `test/`; here
 * we lock the small data projection that the renderer reuses.
 */

import { describe, expect, test } from 'bun:test';

import { filterChildren } from './list';

describe('filterChildren', () => {
	const entries = {
		'counter.get': { type: 'query' as const },
		'counter.set': { type: 'mutation' as const },
		'other.thing': { type: 'query' as const },
	};

	test('exact-leaf path returns empty (caller handles exact match)', () => {
		expect(filterChildren(entries, 'counter.get')).toEqual({});
	});

	test('subtree prefix returns descendants', () => {
		expect(Object.keys(filterChildren(entries, 'counter')).sort()).toEqual([
			'counter.get',
			'counter.set',
		]);
	});

	test('non-matching prefix returns empty', () => {
		expect(filterChildren(entries, 'nope')).toEqual({});
	});
});
