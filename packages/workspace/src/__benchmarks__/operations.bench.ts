/**
 * Operation Speed Benchmarks
 *
 * Answers: "How fast are table, KV, and workspace operations?"
 *
 * Measures insert/get/delete/filter throughput, batch vs individual
 * performance, KV set/get/delete cycles, and workspace creation speed.
 */

import { describe, expect, test } from 'bun:test';
import { Type } from 'typebox';
import * as Y from 'yjs';
import { defineKv } from '../document/define-kv.js';
import { createKv } from '../document/kv.js';
import { attachTable } from '../document/table.js';
import { createEncryptedYkvLww } from '../shared/y-keyvalue/y-keyvalue-lww-encrypted.js';
import { generateId, measureTime, postDefinition } from './helpers.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Table Operations
// ═══════════════════════════════════════════════════════════════════════════════

describe('table operations', () => {
	test('insert 1,000 rows', () => {
		const ydoc = new Y.Doc();
		const tables = { posts: attachTable(ydoc, 'posts', postDefinition) };

		const { durationMs } = measureTime(() => {
			for (let i = 0; i < 1_000; i++) {
				tables.posts.set({
					id: generateId(i),
					title: `Post ${i}`,
					views: i,
				});
			}
		});

		console.log(
			`Insert 1,000 rows: ${durationMs.toFixed(2)}ms (${Math.round(1_000 / (durationMs / 1_000))} ops/sec)`,
		);
		console.log(`Average per insert: ${(durationMs / 1_000).toFixed(4)}ms`);
		expect(tables.posts.storedCount()).toBe(1_000);
	});

	test('insert 10,000 rows', () => {
		const ydoc = new Y.Doc();
		const tables = { posts: attachTable(ydoc, 'posts', postDefinition) };

		const { durationMs } = measureTime(() => {
			for (let i = 0; i < 10_000; i++) {
				tables.posts.set({
					id: generateId(i),
					title: `Post ${i}`,
					views: i,
				});
			}
		});

		console.log(
			`Insert 10,000 rows: ${durationMs.toFixed(2)}ms (${Math.round(10_000 / (durationMs / 1_000))} ops/sec)`,
		);
		console.log(`Average per insert: ${(durationMs / 10_000).toFixed(4)}ms`);
		expect(tables.posts.storedCount()).toBe(10_000);
	});

	test('get 10,000 rows by ID', () => {
		const ydoc = new Y.Doc();
		const tables = { posts: attachTable(ydoc, 'posts', postDefinition) };

		for (let i = 0; i < 10_000; i++) {
			tables.posts.set({
				id: generateId(i),
				title: `Post ${i}`,
				views: i,
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

	test('scan / scan().rows.filter with 10,000 rows', () => {
		const ydoc = new Y.Doc();
		const tables = { posts: attachTable(ydoc, 'posts', postDefinition) };

		for (let i = 0; i < 10_000; i++) {
			tables.posts.set({
				id: generateId(i),
				title: `Post ${i}`,
				views: i,
			});
		}

		const { durationMs: scanMs } = measureTime(() => tables.posts.scan());
		const { durationMs: scanRowsMs } = measureTime(
			() => tables.posts.scan().rows,
		);
		const { durationMs: filterMs } = measureTime(() =>
			tables.posts.scan().rows.filter((row) => row.views > 5000),
		);

		console.log(`scan: ${scanMs.toFixed(2)}ms`);
		console.log(`scan().rows: ${scanRowsMs.toFixed(2)}ms`);
		console.log(`scan().rows.filter: ${filterMs.toFixed(2)}ms`);
	});

	test('delete 1,000 rows', () => {
		const ydoc = new Y.Doc();
		const tables = { posts: attachTable(ydoc, 'posts', postDefinition) };

		for (let i = 0; i < 1_000; i++) {
			tables.posts.set({
				id: generateId(i),
				title: `Post ${i}`,
				views: i,
			});
		}

		const { durationMs } = measureTime(() => {
			for (let i = 0; i < 1_000; i++) {
				tables.posts.delete(generateId(i));
			}
		});

		console.log(`Delete 1,000 rows: ${durationMs.toFixed(2)}ms`);
		console.log(`Average per delete: ${(durationMs / 1_000).toFixed(4)}ms`);
		expect(tables.posts.storedCount()).toBe(0);
	});

	test('batch insert vs individual insert (1,000 rows)', () => {
		const ydoc1 = new Y.Doc();
		const tables1 = { posts: attachTable(ydoc1, 'posts', postDefinition) };

		const { durationMs: individualMs } = measureTime(() => {
			for (let i = 0; i < 1_000; i++) {
				tables1.posts.set({
					id: generateId(i),
					title: `Post ${i}`,
					views: i,
				});
			}
		});

		const ydoc2 = new Y.Doc();
		const tables2 = { posts: attachTable(ydoc2, 'posts', postDefinition) };

		const { durationMs: batchMs } = measureTime(() => {
			ydoc2.transact(() => {
				for (let i = 0; i < 1_000; i++) {
					tables2.posts.set({
						id: generateId(i),
						title: `Post ${i}`,
						views: i,
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
			counter: defineKv(Type.Object({ value: Type.Number() }), () => ({
				value: 0,
			})),
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
			counter: defineKv(Type.Object({ value: Type.Number() }), () => ({
				value: 0,
			})),
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
			counter: defineKv(Type.Object({ value: Type.Number() }), () => ({
				value: 0,
			})),
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
