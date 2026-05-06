/**
 * defineTable Tests
 *
 * Verifies single-schema and variadic multi-version table definitions, including schema migration.
 * These tests ensure table contracts remain stable for runtime validation and for typed documents.
 *
 * Key behaviors:
 * - Table schemas validate expected row shapes across versions.
 * - Migration functions upgrade legacy rows to the latest schema.
 */

import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import { defineTable } from './define-table.js';

describe('defineTable', () => {
	describe('shorthand syntax', () => {
		test('creates valid table definition with direct schema', () => {
			const posts = defineTable(
				type({ id: 'string', title: 'string', _v: '1' }),
			);

			// Verify schema validates correctly
			const result = posts.schema['~standard'].validate({
				id: '1',
				title: 'Hello',
				_v: 1,
			});
			expect(result).not.toHaveProperty('issues');
		});

	});

	describe('variadic syntax', () => {
		test('creates table definition with multiple versions that validates both', () => {
			const posts = defineTable(
				type({ id: 'string', title: 'string', _v: '1' }),
				type({ id: 'string', title: 'string', views: 'number', _v: '2' }),
			).migrate((row) => {
				if (row._v === 1) return { ...row, views: 0, _v: 2 };
				return row;
			});

			// V1 data should validate
			const v1Result = posts.schema['~standard'].validate({
				id: '1',
				title: 'Test',
				_v: 1,
			});
			expect(v1Result).not.toHaveProperty('issues');

			// V2 data should validate
			const v2Result = posts.schema['~standard'].validate({
				id: '1',
				title: 'Test',
				views: 10,
				_v: 2,
			});
			expect(v2Result).not.toHaveProperty('issues');
		});

		test('migrate function upgrades old rows to latest version', () => {
			const posts = defineTable(
				type({ id: 'string', title: 'string', _v: '1' }),
				type({ id: 'string', title: 'string', views: 'number', _v: '2' }),
			).migrate((row) => {
				if (row._v === 1) return { ...row, views: 0, _v: 2 };
				return row;
			});

			// Migrate v1 to v2
			const migrated = posts.migrate({
				id: '1',
				title: 'Test',
				_v: 1,
			});
			expect(migrated).toEqual({ id: '1', title: 'Test', views: 0, _v: 2 });
		});

		test('requires at least one schema argument', () => {
			expect(() => {
				// @ts-expect-error no arguments provided
				defineTable();
			}).toThrow();
		});
	});

	describe('schema patterns', () => {
		test('three-version migration composes v1→v2→v3 and preserves latest rows', () => {
			const posts = defineTable(
				type({ id: 'string', title: 'string', _v: '1' }),
				type({
					id: 'string',
					title: 'string',
					views: 'number',
					_v: '2',
				}),
				type({
					id: 'string',
					title: 'string',
					views: 'number',
					author: 'string',
					_v: '3',
				}),
			).migrate((row) => {
				switch (row._v) {
					case 1:
						return { ...row, views: 0, author: 'unknown', _v: 3 };
					case 2:
						return { ...row, author: 'unknown', _v: 3 };
					case 3:
						return row;
				}
			});

			// All three versions validate
			for (const input of [
				{ id: '1', title: 'Test', _v: 1 },
				{ id: '1', title: 'Test', views: 10, _v: 2 },
				{ id: '1', title: 'Test', views: 10, author: 'a', _v: 3 },
			]) {
				expect(posts.schema['~standard'].validate(input)).not.toHaveProperty(
					'issues',
				);
			}

			// v1 → v3
			expect(posts.migrate({ id: '1', title: 'Test', _v: 1 })).toEqual({
				id: '1',
				title: 'Test',
				views: 0,
				author: 'unknown',
				_v: 3,
			});

			// v2 → v3
			expect(
				posts.migrate({ id: '1', title: 'Test', views: 5, _v: 2 }),
			).toEqual({
				id: '1',
				title: 'Test',
				views: 5,
				author: 'unknown',
				_v: 3,
			});

			// v3 passes through unchanged
			const latest = { id: '1', title: 'Test', views: 5, author: 'a', _v: 3 as const };
			expect(posts.migrate(latest)).toEqual(latest);
		});
	});

});
