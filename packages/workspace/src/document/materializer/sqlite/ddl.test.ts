/**
 * DDL Generation Tests
 *
 * Verifies JSON Schema → CREATE TABLE SQL conversion for the SQLite materializer.
 * Covers JSON Schema type mappings, nullable vs NOT NULL, and edge cases.
 *
 * Key behaviors:
 * - generateDdl maps JSON Schema types to correct SQLite types
 * - id field always becomes TEXT PRIMARY KEY
 * - required fields get NOT NULL, optional fields allow NULL
 * - object/array types serialize to TEXT (JSON)
 * - enum types map to TEXT
 *
 * Note: `_v` is library-managed and stripped from the user-facing row schema,
 * so it never appears in generated DDL.
 */

import { describe, expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import type { TSchema } from 'typebox';
import { generateDdl } from './ddl.js';

function objectSchema(
	properties: Record<string, TSchema | Record<string, unknown>>,
	required: string[] = [],
) {
	return {
		type: 'object' as const,
		properties,
		required,
	} as unknown as TSchema;
}

describe('generateDdl', () => {
	test('generates correct DDL for a simple table', () => {
		const schema = {
			type: 'object',
			properties: {
				id: { type: 'string' },
				title: { type: 'string' },
				published: { type: 'boolean' },
			},
			required: ['id', 'title'],
		} as unknown as TSchema;

		const sql = generateDdl('posts', schema);

		expect(sql).toBe(
			'CREATE TABLE IF NOT EXISTS "posts" ("id" TEXT PRIMARY KEY, "title" TEXT NOT NULL, "published" INTEGER)',
		);
	});

	test('maps string type to TEXT', () => {
		const sql = generateDdl(
			'posts',
			objectSchema({ title: { type: 'string' } }, ['title']),
		);

		expect(sql).toBe(
			'CREATE TABLE IF NOT EXISTS "posts" ("title" TEXT NOT NULL)',
		);
	});

	test('maps field.instant() to TEXT for lexicographic time ordering', () => {
		// `field.instant()` emits a string schema carrying `date-time` format and
		// the fixed-width instant pattern. The materialized column must be TEXT so
		// the canonical UTC instants sort lexicographically = chronologically.
		const sql = generateDdl(
			'posts',
			objectSchema({ createdAt: field.instant() }, ['createdAt']),
		);

		expect(sql).toBe(
			'CREATE TABLE IF NOT EXISTS "posts" ("createdAt" TEXT NOT NULL)',
		);
	});

	test('maps number type to REAL', () => {
		const sql = generateDdl(
			'posts',
			objectSchema({ score: { type: 'number' } }, ['score']),
		);

		expect(sql).toBe(
			'CREATE TABLE IF NOT EXISTS "posts" ("score" REAL NOT NULL)',
		);
	});

	test('maps integer type to INTEGER', () => {
		const sql = generateDdl(
			'posts',
			objectSchema({ count: { type: 'integer' } }, ['count']),
		);

		expect(sql).toBe(
			'CREATE TABLE IF NOT EXISTS "posts" ("count" INTEGER NOT NULL)',
		);
	});

	test('maps boolean type to INTEGER', () => {
		const sql = generateDdl(
			'posts',
			objectSchema({ published: { type: 'boolean' } }, ['published']),
		);

		expect(sql).toBe(
			'CREATE TABLE IF NOT EXISTS "posts" ("published" INTEGER NOT NULL)',
		);
	});

	test('maps enum to TEXT', () => {
		const sql = generateDdl(
			'posts',
			objectSchema({ status: { enum: ['A', 'B'] } }, ['status']),
		);

		expect(sql).toBe(
			'CREATE TABLE IF NOT EXISTS "posts" ("status" TEXT NOT NULL)',
		);
	});

	test('maps required object type to TEXT NOT NULL', () => {
		const sql = generateDdl(
			'posts',
			objectSchema({ metadata: { type: 'object' } }, ['metadata']),
		);

		expect(sql).toBe(
			'CREATE TABLE IF NOT EXISTS "posts" ("metadata" TEXT NOT NULL)',
		);
	});

	test('maps required array type to TEXT NOT NULL', () => {
		const sql = generateDdl(
			'posts',
			objectSchema({ tags: { type: 'array' } }, ['tags']),
		);

		expect(sql).toBe(
			'CREATE TABLE IF NOT EXISTS "posts" ("tags" TEXT NOT NULL)',
		);
	});

	test('optional fields omit NOT NULL', () => {
		const sql = generateDdl(
			'posts',
			objectSchema({ title: { type: 'string' } }),
		);

		expect(sql).toBe('CREATE TABLE IF NOT EXISTS "posts" ("title" TEXT)');
	});

	test('id field is always TEXT PRIMARY KEY regardless of required', () => {
		const sql = generateDdl('posts', objectSchema({ id: { type: 'string' } }));

		expect(sql).toBe(
			'CREATE TABLE IF NOT EXISTS "posts" ("id" TEXT PRIMARY KEY)',
		);
	});

	test('quotes table name with double quotes', () => {
		const sql = generateDdl(
			'select',
			objectSchema({ id: { type: 'string' } }, ['id']),
		);

		expect(sql).toBe(
			'CREATE TABLE IF NOT EXISTS "select" ("id" TEXT PRIMARY KEY)',
		);
	});

	test('quotes column names with double quotes', () => {
		const sql = generateDdl(
			'posts',
			objectSchema(
				{
					select: { type: 'string' },
					'say"hi"': { type: 'string' },
				},
				['select', 'say"hi"'],
			),
		);

		expect(sql).toBe(
			'CREATE TABLE IF NOT EXISTS "posts" ("select" TEXT NOT NULL, "say""hi""" TEXT NOT NULL)',
		);
	});
});
