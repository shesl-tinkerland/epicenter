/**
 * Memory Pressure Benchmarks
 *
 * Answers: "When do we hit memory walls? How much heap does a large doc consume?"
 *
 * Measures JavaScript heap usage at various document sizes. This is especially
 * relevant for lower-end devices (phones, tablets, cheap laptops) where memory
 * is the constraint before CPU speed.
 *
 * Uses process.memoryUsage().heapUsed with forced GC between measurements
 * for accurate readings.
 */

import { describe, test } from 'bun:test';
import * as Y from 'yjs';
import { attachTable } from '../index.js';
import {
	formatBytes,
	generateId,
	heavyNoteDefinition,
	makeHeavyRow,
	noteDefinition,
	postDefinition,
} from './helpers.js';

/** Force garbage collection and return heap used */
function getHeapUsed(): number {
	// Bun supports Bun.gc() for explicit GC
	if (typeof Bun !== 'undefined' && typeof Bun.gc === 'function') {
		Bun.gc(true);
	}
	return process.memoryUsage().heapUsed;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Heap Usage: Small Rows at Scale
// ═══════════════════════════════════════════════════════════════════════════════

describe('heap usage: small rows', () => {
	test('memory per 1K / 10K / 50K small rows', () => {
		console.log('\n=== HEAP USAGE: SMALL ROWS ===');
		console.log('| Rows     | Heap Used   | Per Row    | Binary Size  |');
		console.log('|----------|-------------|------------|--------------|');

		for (const count of [1_000, 10_000, 50_000]) {
			const heapBefore = getHeapUsed();

			const ydoc = new Y.Doc();
			const tables = { posts: attachTable(ydoc, "posts", postDefinition) };

			for (let i = 0; i < count; i++) {
				tables.posts.set({
					id: generateId(i),
					title: `Post ${i}`,
					views: i,
					_v: 1,
				});
			}

			const heapAfter = getHeapUsed();
			const heapDelta = heapAfter - heapBefore;
			const binarySize = Y.encodeStateAsUpdate(ydoc).byteLength;

			console.log(
				`| ${String(count).padStart(8)} | ${formatBytes(heapDelta).padEnd(11)} | ${formatBytes(Math.round(heapDelta / count)).padEnd(10)} | ${formatBytes(binarySize).padEnd(12)} |`,
			);

			// Cleanup to not pollute next iteration
			ydoc.destroy();
		}
	}, 120_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Heap Usage: Content-Heavy Rows
// ═══════════════════════════════════════════════════════════════════════════════

describe('heap usage: content-heavy rows', () => {
	test('memory for notes with varying content size', () => {
		console.log('\n=== HEAP USAGE: CONTENT-HEAVY ROWS ===');
		console.log(
			'| Content    | Rows | Heap Used   | Binary Size  | Heap/Binary |',
		);
		console.log(
			'|------------|------|-------------|--------------|-------------|',
		);

		const configs = [
			{ content: 500, rows: 1_000 },
			{ content: 5_000, rows: 100 },
			{ content: 50_000, rows: 10 },
			{ content: 100_000, rows: 5 },
		];

		for (const { content, rows } of configs) {
			const heapBefore = getHeapUsed();

			const ydoc = new Y.Doc();
			const tables = { notes: attachTable(ydoc, "notes", heavyNoteDefinition) };

			for (let i = 0; i < rows; i++) {
				tables.notes.set(makeHeavyRow(`doc-${i}`, content));
			}

			const heapAfter = getHeapUsed();
			const heapDelta = heapAfter - heapBefore;
			const binarySize = Y.encodeStateAsUpdate(ydoc).byteLength;
			const ratio = (heapDelta / binarySize).toFixed(1);

			console.log(
				`| ${formatBytes(content).padEnd(10)} | ${String(rows).padStart(4)} | ${formatBytes(heapDelta).padEnd(11)} | ${formatBytes(binarySize).padEnd(12)} | ${ratio.padStart(7)}x    |`,
			);

			ydoc.destroy();
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// Heap Overhead: Binary vs In-Memory
// ═══════════════════════════════════════════════════════════════════════════════

describe('heap overhead: binary vs in-memory', () => {
	test('Y.Doc heap is larger than binary (CRDT metadata in RAM)', () => {
		const heapBefore = getHeapUsed();

		const ydoc = new Y.Doc();
		const tables = { notes: attachTable(ydoc, "notes", noteDefinition) };

		const content = 'x'.repeat(400);
		for (let i = 0; i < 5_000; i++) {
			tables.notes.set({
				id: generateId(i),
				title: `Note ${i}`,
				content,
				tags: ['tag1'],
				createdAt: Date.now(),
				updatedAt: Date.now(),
				_v: 1,
			});
		}

		const heapAfter = getHeapUsed();
		const heapDelta = heapAfter - heapBefore;
		const binarySize = Y.encodeStateAsUpdate(ydoc).byteLength;

		console.log('\n=== HEAP VS BINARY: 5K notes ===');
		console.log(`  In-memory heap:  ${formatBytes(heapDelta)}`);
		console.log(`  Binary on disk:  ${formatBytes(binarySize)}`);
		console.log(
			`  Heap multiplier: ${(heapDelta / binarySize).toFixed(1)}x (CRDT metadata + JS overhead)`,
		);
		console.log('');
		console.log('  Why heap > binary:');
		console.log(
			'    • Y.Doc maintains Item linked list with prev/next pointers',
		);
		console.log('    • Each Item has JS object overhead (~64-128 bytes)');
		console.log(
			'    • Map indexes (YKeyValueLww.map) duplicate key references',
		);
		console.log(
			'    • Binary encoding is compact (variable-length integers, no pointers)',
		);

		ydoc.destroy();
	});
});
