/**
 * Stress Cycle Benchmarks
 *
 * Answers: "What happens to performance and doc size under repeated add/remove cycles?"
 *
 * Simulates worst-case CRDT churn: bulk inserts followed by bulk deletes,
 * repeated over multiple cycles. Measures timing degradation and binary size growth.
 */

import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { attachTable } from '../index.js';
import {
	eventDefinition,
	generateId,
	measureTime,
	postDefinition,
	sampleEventPayload,
} from './helpers.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Repeated Add/Remove Cycles
// ═══════════════════════════════════════════════════════════════════════════════

describe('repeated add/remove cycles', () => {
	test('1,000 items: add and remove 5 cycles', () => {
		const ydoc = new Y.Doc();
		const tables = { posts: attachTable(ydoc, "posts", postDefinition) };

		const cycleTimes: number[] = [];

		const { durationMs: totalDuration } = measureTime(() => {
			for (let cycle = 0; cycle < 5; cycle++) {
				const cycleStart = performance.now();

				for (let i = 0; i < 1_000; i++) {
					tables.posts.set({
						id: generateId(i),
						title: `Post ${i}`,
						views: i,
						_v: 1,
					});
				}

				for (let i = 0; i < 1_000; i++) {
					tables.posts.delete(generateId(i));
				}

				cycleTimes.push(performance.now() - cycleStart);
			}
		});

		console.log(
			`5 cycles of add/remove 1,000 items: ${totalDuration.toFixed(2)}ms`,
		);
		console.log(`Average cycle time: ${(totalDuration / 5).toFixed(2)}ms`);
		console.log(
			`First cycle: ${cycleTimes[0]?.toFixed(2)}ms, Last: ${cycleTimes[4]?.toFixed(2)}ms`,
		);
		expect(tables.posts.count()).toBe(0);
	});

	test('1,000 items: Y.Doc size growth over 5 cycles', () => {
		const ydoc = new Y.Doc();
		const tables = { posts: attachTable(ydoc, "posts", postDefinition) };

		const docSizes: number[] = [];

		for (let cycle = 0; cycle < 5; cycle++) {
			for (let i = 0; i < 1_000; i++) {
				tables.posts.set({
					id: generateId(i),
					title: `Post ${i}`,
					views: i,
					_v: 1,
				});
			}

			for (let i = 0; i < 1_000; i++) {
				tables.posts.delete(generateId(i));
			}

			docSizes.push(Y.encodeStateAsUpdate(ydoc).byteLength);
		}

		console.log('Y.Doc size after each cycle (bytes):');
		for (let i = 0; i < docSizes.length; i++) {
			console.log(`  Cycle ${i + 1}: ${docSizes[i]?.toLocaleString()}`);
		}
		expect(tables.posts.count()).toBe(0);
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// Event Log Stress Test
// ═══════════════════════════════════════════════════════════════════════════════

describe('event log stress', () => {
	test('1,000 events: add, delete, measure binary size over 5 cycles', () => {
		const ydoc = new Y.Doc();
		const tables = { events: attachTable(ydoc, "events", eventDefinition) };

		const sizes: number[] = [];

		for (let cycle = 0; cycle < 5; cycle++) {
			for (let i = 0; i < 1_000; i++) {
				tables.events.set({
					id: generateId(i),
					type: i % 2 === 0 ? 'command' : 'event',
					name: `action_${i}`,
					payload: sampleEventPayload,
					timestamp: Date.now(),
					_v: 1,
				});
			}

			for (let i = 0; i < 1_000; i++) {
				tables.events.delete(generateId(i));
			}

			sizes.push(Y.encodeStateAsUpdate(ydoc).byteLength);
		}

		console.log('\n=== Event Log: Binary Size After Add/Delete Cycles ===');
		for (let i = 0; i < sizes.length; i++) {
			console.log(
				`  Cycle ${i + 1}: ${sizes[i]} bytes (${tables.events.count()} rows)`,
			);
		}

		// After full add/delete cycles, doc should be tiny (just LWW metadata)
		const finalSize = sizes.at(-1) ?? 0;
		expect(finalSize).toBeLessThan(100);
		expect(tables.events.count()).toBe(0);
	});

	test('binary size: 1,000 events retained vs after deletion', () => {
		const ydoc = new Y.Doc();
		const tables = { events: attachTable(ydoc, "events", eventDefinition) };

		for (let i = 0; i < 1_000; i++) {
			tables.events.set({
				id: generateId(i),
				type: 'event',
				name: `action_${i}`,
				payload: sampleEventPayload,
				timestamp: Date.now(),
				_v: 1,
			});
		}

		const retainedSize = Y.encodeStateAsUpdate(ydoc).byteLength;

		for (let i = 0; i < 1_000; i++) {
			tables.events.delete(generateId(i));
		}

		const afterDeleteSize = Y.encodeStateAsUpdate(ydoc).byteLength;

		console.log('\n=== Event Log: Retained vs Deleted ===');
		console.log(
			`  1,000 events retained: ${(retainedSize / 1024).toFixed(2)} KB`,
		);
		console.log(`  After deleting all:    ${afterDeleteSize} bytes`);
		console.log(
			`  Reduction:             ${((1 - afterDeleteSize / retainedSize) * 100).toFixed(1)}%`,
		);

		expect(afterDeleteSize).toBeLessThan(100);
	});
});
