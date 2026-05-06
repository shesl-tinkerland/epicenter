/**
 * Operation Speed Benchmarks
 *
 * Answers: "How fast are table, KV, and workspace operations?"
 *
 * Measures insert/get/delete/filter throughput, batch vs individual
 * performance, KV set/get/delete cycles, and workspace creation speed.
 */

import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { type } from 'arktype';
import { createEncryptedYkvLww } from '../shared/y-keyvalue/y-keyvalue-lww-encrypted.js';
import { attachTable } from '../index.js';
import { createKv } from '../document/internal.js';
import { defineKv } from '../document/define-kv.js';
import {
	generateId,
	measureTime,
	postDefinition,
} from './helpers.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Table Operations
// ═══════════════════════════════════════════════════════════════════════════════

describe('table operations', () => {
	test('insert 1,000 rows', () => {
		const ydoc = new Y.Doc();
		const tables = { posts: attachTable(ydoc, "posts", postDefinition) };

		const { durationMs } = measureTime(() => {
			for (let i = 0; i < 1_000; i++) {
				tables.posts.set({
					id: generateId(i),
					title: `Post ${i}`,
					views: i,
					_v: 1,
				});
			}
		});

		console.log(`Insert 1,000 rows: ${durationMs.toFixed(2)}ms (${Math.round(1_000 / (durationMs / 1_000))} ops/sec)`);
		console.log(`Average per insert: ${(durationMs / 1_000).toFixed(4)}ms`);
		expect(tables.posts.count()).toBe(1_000);
	});

	test('insert 10,000 rows', () => {
		const ydoc = new Y.Doc();
		const tables = { posts: attachTable(ydoc, "posts", postDefinition) };

		const { durationMs } = measureTime(() => {
			for (let i = 0; i < 10_000; i++) {
				tables.posts.set({
					id: generateId(i),
					title: `Post ${i}`,
					views: i,
					_v: 1,
				});
			}
		});

		console.log(`Insert 10,000 rows: ${durationMs.toFixed(2)}ms (${Math.round(10_000 / (durationMs / 1_000))} ops/sec)`);
		console.log(`Average per insert: ${(durationMs / 10_000).toFixed(4)}ms`);
		expect(tables.posts.count()).toBe(10_000);
	});

	test('get 10,000 rows by ID', () => {
		const ydoc = new Y.Doc();
		const tables = { posts: attachTable(ydoc, "posts", postDefinition) };

		for (let i = 0; i < 10_000; i++) {
			tables.posts.set({
				id: generateId(i),
				title: `Post ${i}`,
				views: i,
				_v: 1,
			});
		}

		const { durationMs } = measureTime(() => {
			for (let i = 0; i < 10_000; i++) {
				tables.posts.get(generateId(i));
			}
		});

		console.log(`Get 10,000 rows: ${durationMs.toFixed(2)}ms`);
		console.log(`Average per get: ${(durationMs / 10_000).toFixed(4)}ms`);
	});

	test('getAll / getAllValid / filter with 10,000 rows', () => {
		const ydoc = new Y.Doc();
		const tables = { posts: attachTable(ydoc, "posts", postDefinition) };

		for (let i = 0; i < 10_000; i++) {
			tables.posts.set({
				id: generateId(i),
				title: `Post ${i}`,
				views: i,
				_v: 1,
			});
		}

		const { durationMs: getAllMs } = measureTime(() => tables.posts.getAll());
		const { durationMs: getAllValidMs } = measureTime(() =>
			tables.posts.getAllValid(),
		);
		const { durationMs: filterMs } = measureTime(() =>
			tables.posts.filter((row) => row.views > 5000),
		);

		console.log(`getAll: ${getAllMs.toFixed(2)}ms`);
		console.log(`getAllValid: ${getAllValidMs.toFixed(2)}ms`);
		console.log(`filter: ${filterMs.toFixed(2)}ms`);
	});

	test('delete 1,000 rows', () => {
		const ydoc = new Y.Doc();
		const tables = { posts: attachTable(ydoc, "posts", postDefinition) };

		for (let i = 0; i < 1_000; i++) {
			tables.posts.set({
				id: generateId(i),
				title: `Post ${i}`,
				views: i,
				_v: 1,
			});
		}

		const { durationMs } = measureTime(() => {
			for (let i = 0; i < 1_000; i++) {
				tables.posts.delete(generateId(i));
			}
		});

		console.log(`Delete 1,000 rows: ${durationMs.toFixed(2)}ms`);
		console.log(`Average per delete: ${(durationMs / 1_000).toFixed(4)}ms`);
		expect(tables.posts.count()).toBe(0);
	});

	test('batch insert vs individual insert (1,000 rows)', () => {
		const ydoc1 = new Y.Doc();
		const tables1 = { posts: attachTable(ydoc1, "posts", postDefinition) };

		const { durationMs: individualMs } = measureTime(() => {
			for (let i = 0; i < 1_000; i++) {
				tables1.posts.set({
					id: generateId(i),
					title: `Post ${i}`,
					views: i,
					_v: 1,
				});
			}
		});

		const ydoc2 = new Y.Doc();
		const tables2 = { posts: attachTable(ydoc2, "posts", postDefinition) };

		const { durationMs: batchMs } = measureTime(() => {
			ydoc2.transact(() => {
				for (let i = 0; i < 1_000; i++) {
					tables2.posts.set({
						id: generateId(i),
						title: `Post ${i}`,
						views: i,
						_v: 1,
					});
				}
			});
		});

		console.log(`Individual inserts: ${individualMs.toFixed(2)}ms`);
		console.log(`Batch insert: ${batchMs.toFixed(2)}ms`);
		console.log(`Speedup: ${(individualMs / batchMs).toFixed(2)}x`);
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// KV Operations
// ═══════════════════════════════════════════════════════════════════════════════

describe('KV operations', () => {
	test('repeated set on same key (10,000 times)', () => {
		const ydoc = new Y.Doc();
		const ykv = createEncryptedYkvLww<unknown>(ydoc, 'kv');
		const kv = createKv(ykv, {
			counter: defineKv(type({ value: 'number' }), { value: 0 }),
		});

		const { durationMs } = measureTime(() => {
			for (let i = 0; i < 10_000; i++) {
				kv.set('counter', { value: i });
			}
		});

		console.log(`Set same KV key 10,000 times: ${durationMs.toFixed(2)}ms`);
		console.log(`Average per set: ${(durationMs / 10_000).toFixed(4)}ms`);

		const result = kv.get('counter');
		expect(result).toEqual({ value: 9_999 });
	});

	test('set + get alternating (10,000 cycles)', () => {
		const ydoc = new Y.Doc();
		const ykv = createEncryptedYkvLww<unknown>(ydoc, 'kv');
		const kv = createKv(ykv, {
			counter: defineKv(type({ value: 'number' }), { value: 0 }),
		});

		const { durationMs } = measureTime(() => {
			for (let i = 0; i < 10_000; i++) {
				kv.set('counter', { value: i });
				kv.get('counter');
			}
		});

		console.log(`Set + Get 10,000 cycles: ${durationMs.toFixed(2)}ms`);
		console.log(`Average per cycle: ${(durationMs / 10_000).toFixed(4)}ms`);
	});

	test('set + delete cycle (1,000 times)', () => {
		const ydoc = new Y.Doc();
		const ykv = createEncryptedYkvLww<unknown>(ydoc, 'kv');
		const kv = createKv(ykv, {
			counter: defineKv(type({ value: 'number' }), { value: 0 }),
		});

		const { durationMs } = measureTime(() => {
			for (let i = 0; i < 1_000; i++) {
				kv.set('counter', { value: i });
				kv.delete('counter');
			}
		});

		console.log(`Set + Delete 1,000 cycles: ${durationMs.toFixed(2)}ms`);
		console.log(`Average per cycle: ${(durationMs / 1_000).toFixed(4)}ms`);
		expect(kv.get('counter')).toEqual({ value: 0 });
	});
});
