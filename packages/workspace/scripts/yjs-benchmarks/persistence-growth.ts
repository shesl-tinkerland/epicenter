/**
 * IndexedDB Storage Growth Benchmark
 *
 * Simulates exactly what y-indexeddb does under the hood:
 *   1. Each Y.Doc update is stored as a separate entry (incremental)
 *   2. Every 500 updates, it compacts by encoding the full doc state
 *      and deleting all prior entries
 *
 * We measure:
 *   - Y.Doc encoded state size (= compacted IndexedDB size)
 *   - Cumulative update bytes (= IndexedDB size between compactions)
 *   - Whether compacted size grows monotonically across add/delete cycles
 *
 * Run: bun packages/workspace/scripts/yjs-benchmarks/persistence-growth.ts
 */

import { type } from 'arktype';
import * as Y from 'yjs';
import { attachTable, defineTable } from '../../src/index.js';
import { formatBytes } from './helpers.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════════════════════

/** y-indexeddb compacts after this many updates */
const IDB_TRIM_SIZE = 500;

const ROWS_TO_ADD = 10_000;
const ROWS_TO_DELETE = 10_000;
const STEADY_STATE_ROWS = 1_000;
const CYCLES = 5;

// ═══════════════════════════════════════════════════════════════════════════════
// Schema
// ═══════════════════════════════════════════════════════════════════════════════

const eventDefinition = defineTable(
	type({
		id: 'string',
		_v: '1',
		type: "'command' | 'event'",
		name: 'string',
		payload: 'string',
		timestamp: 'number',
	}),
);

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

const samplePayload = JSON.stringify({
	userId: 'usr-001',
	action: 'click',
	target: 'button.submit',
	metadata: { page: '/dashboard', sessionId: 'sess-abc123' },
});

let globalIdCounter = 0;

function nextId(): string {
	return `evt-${(globalIdCounter++).toString().padStart(8, '0')}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// IndexedDB Simulator
//
// Replicates y-indexeddb's storage behavior:
//   - Stores every update as a separate binary blob
//   - Compacts when entry count >= PREFERRED_TRIM_SIZE (500)
// ═══════════════════════════════════════════════════════════════════════════════

type IdbSnapshot = {
	entryCount: number;
	totalBytes: number;
	compactions: number;
};

function createIdbSimulator(doc: Y.Doc) {
	const updates: Uint8Array[] = [];
	let compactionCount = 0;

	function compact() {
		const snapshot = Y.encodeStateAsUpdate(doc);
		updates.length = 0;
		updates.push(snapshot);
		compactionCount++;
	}

	doc.on('update', (update: Uint8Array) => {
		updates.push(update);
		if (updates.length >= IDB_TRIM_SIZE) {
			compact();
		}
	});

	return {
		snapshot(): IdbSnapshot {
			return {
				entryCount: updates.length,
				totalBytes: updates.reduce((sum, u) => sum + u.byteLength, 0),
				compactions: compactionCount,
			};
		},
		/** Force compaction (like y-indexeddb's storeState with forceStore=true) */
		forceCompact() {
			compact();
		},
	};
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════════

function main() {
	console.log(`${'═'.repeat(80)}`);
	console.log('  IndexedDB Storage Growth Benchmark');
	console.log(`${'═'.repeat(80)}`);
	console.log(`
  Simulates y-indexeddb behavior:
    - Each Y.Doc update → separate IndexedDB entry
    - Compaction every ${IDB_TRIM_SIZE} updates (PREFERRED_TRIM_SIZE)
    - Compaction = encodeStateAsUpdate + delete old entries

  Scenario: ${STEADY_STATE_ROWS} steady-state rows,
            then ${CYCLES} cycles of add ${ROWS_TO_ADD} + delete ${ROWS_TO_DELETE}
            (using unique IDs each cycle to simulate real usage)
`);

	// ── Setup ────────────────────────────────────────────────────────────────
	const ydoc = new Y.Doc();
	const tables = { events: attachTable(ydoc, 'events', eventDefinition) };
	const idb = createIdbSimulator(ydoc);

	// ── Seed steady-state rows ──────────────────────────────────────────────
	const steadyStateIds: string[] = [];
	for (let i = 0; i < STEADY_STATE_ROWS; i++) {
		const id = nextId();
		steadyStateIds.push(id);
		tables.events.set({
			id,
			_v: 1,
			type: i % 2 === 0 ? 'command' : 'event',
			name: `seed_${i}`,
			payload: samplePayload,
			timestamp: Date.now(),
		});
	}

	// Force compaction after seeding to get a clean baseline
	idb.forceCompact();
	const baselineDocSize = Y.encodeStateAsUpdate(ydoc).byteLength;
	const baselineIdb = idb.snapshot();

	console.log(`  Baseline (${STEADY_STATE_ROWS} rows):`);
	console.log(`    Y.Doc encoded size: ${formatBytes(baselineDocSize)}`);
	console.log(
		`    IDB after compact:  ${formatBytes(baselineIdb.totalBytes)} (${baselineIdb.entryCount} entries)`,
	);
	console.log(`    Compactions so far: ${baselineIdb.compactions}`);
	console.log();

	// ── Track growth across cycles ──────────────────────────────────────────
	type CycleResult = {
		cycle: number;
		afterAdd: {
			rows: number;
			docSize: number;
			idb: IdbSnapshot;
		};
		afterDelete: {
			rows: number;
			docSize: number;
			idb: IdbSnapshot;
		};
		afterCompact: {
			docSize: number;
			idb: IdbSnapshot;
		};
	};

	const results: CycleResult[] = [];

	for (let cycle = 0; cycle < CYCLES; cycle++) {
		// ── Add rows with unique IDs ──────────────────────────────────────
		const addedIds: string[] = [];
		for (let i = 0; i < ROWS_TO_ADD; i++) {
			const id = nextId();
			addedIds.push(id);
			tables.events.set({
				id,
				_v: 1,
				type: i % 2 === 0 ? 'command' : 'event',
				name: `cycle${cycle}_add_${i}`,
				payload: samplePayload,
				timestamp: Date.now(),
			});
		}

		const afterAddDocSize = Y.encodeStateAsUpdate(ydoc).byteLength;
		const afterAddIdb = idb.snapshot();
		const afterAddRows = tables.events.count();

		// ── Delete the rows we just added ─────────────────────────────────
		for (const id of addedIds) {
			tables.events.delete(id);
		}

		const afterDeleteDocSize = Y.encodeStateAsUpdate(ydoc).byteLength;
		const afterDeleteIdb = idb.snapshot();

		// ── Force compaction (simulate the trim) ──────────────────────────
		idb.forceCompact();
		const afterCompactDocSize = Y.encodeStateAsUpdate(ydoc).byteLength;
		const afterCompactIdb = idb.snapshot();

		results.push({
			cycle: cycle + 1,
			afterAdd: {
				rows: afterAddRows,
				docSize: afterAddDocSize,
				idb: afterAddIdb,
			},
			afterDelete: {
				rows: tables.events.count(),
				docSize: afterDeleteDocSize,
				idb: afterDeleteIdb,
			},
			afterCompact: {
				docSize: afterCompactDocSize,
				idb: afterCompactIdb,
			},
		});
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// Report
	// ═══════════════════════════════════════════════════════════════════════════

	console.log(`${'─'.repeat(80)}`);
	console.log('  Per-Cycle Details');
	console.log(`${'─'.repeat(80)}`);
	console.log();

	for (const r of results) {
		console.log(`  ── Cycle ${r.cycle}/${CYCLES} ──`);
		console.log(`    After adding ${ROWS_TO_ADD} rows:`);
		console.log(
			`      Rows:          ${STEADY_STATE_ROWS} steady + ${ROWS_TO_ADD} added = ${r.afterAdd.rows}`,
		);
		console.log(`      Y.Doc size:    ${formatBytes(r.afterAdd.docSize)}`);
		console.log(
			`      IDB size:      ${formatBytes(r.afterAdd.idb.totalBytes)} (${r.afterAdd.idb.entryCount} entries, ${r.afterAdd.idb.compactions} compactions)`,
		);
		console.log();
		console.log(`    After deleting ${ROWS_TO_DELETE} rows:`);
		console.log(`      Rows:          ${r.afterDelete.rows}`);
		console.log(`      Y.Doc size:    ${formatBytes(r.afterDelete.docSize)}`);
		console.log(
			`      IDB size:      ${formatBytes(r.afterDelete.idb.totalBytes)} (${r.afterDelete.idb.entryCount} entries, ${r.afterDelete.idb.compactions} compactions)`,
		);
		console.log();
		console.log(`    After compaction:`);
		console.log(`      Y.Doc size:    ${formatBytes(r.afterCompact.docSize)}`);
		console.log(
			`      IDB size:      ${formatBytes(r.afterCompact.idb.totalBytes)} (1 entry)`,
		);
		console.log();
	}

	// ── Compacted Size Trend (the key metric) ────────────────────────────────
	console.log(`${'═'.repeat(80)}`);
	console.log('  COMPACTED SIZE TREND (after each cycle)');
	console.log(
		`  This is what matters — the floor IndexedDB returns to after compaction.`,
	);
	console.log(`${'═'.repeat(80)}`);
	console.log();
	console.log(
		`  ${'Cycle'.padEnd(8)} ${'Rows'.padStart(8)} ${'Y.Doc Size'.padStart(14)} ${'Compacted IDB'.padStart(16)} ${'Δ from Baseline'.padStart(18)}`,
	);
	console.log(`  ${'─'.repeat(66)}`);
	console.log(
		`  ${'Base'.padEnd(8)} ${STEADY_STATE_ROWS.toString().padStart(8)} ${formatBytes(baselineDocSize).padStart(14)} ${formatBytes(baselineIdb.totalBytes).padStart(16)} ${'—'.padStart(18)}`,
	);

	for (const r of results) {
		const delta = r.afterCompact.docSize - baselineDocSize;
		const deltaStr =
			delta >= 0 ? `+${formatBytes(delta)}` : `-${formatBytes(-delta)}`;
		const pct = ((delta / baselineDocSize) * 100).toFixed(1);
		console.log(
			`  ${`C${r.cycle}`.padEnd(8)} ${r.afterDelete.rows.toString().padStart(8)} ${formatBytes(r.afterCompact.docSize).padStart(14)} ${formatBytes(r.afterCompact.idb.totalBytes).padStart(16)} ${`${deltaStr} (${pct}%)`.padStart(18)}`,
		);
	}

	console.log();

	// ── Peak IDB sizes (between compactions) ────────────────────────────────
	console.log(`${'═'.repeat(80)}`);
	console.log(
		'  PEAK IDB SIZE (before compaction — what the browser actually stores)',
	);
	console.log(`${'═'.repeat(80)}`);
	console.log();
	console.log(
		`  ${'Cycle'.padEnd(8)} ${'Peak IDB Size'.padStart(16)} ${'Entries'.padStart(10)} ${'Compactions'.padStart(13)}`,
	);
	console.log(`  ${'─'.repeat(50)}`);

	for (const r of results) {
		// The peak is whichever is larger: after add or after delete (usually after delete)
		const peakIdb =
			r.afterDelete.idb.totalBytes > r.afterAdd.idb.totalBytes
				? r.afterDelete.idb
				: r.afterAdd.idb;
		console.log(
			`  ${`C${r.cycle}`.padEnd(8)} ${formatBytes(peakIdb.totalBytes).padStart(16)} ${peakIdb.entryCount.toString().padStart(10)} ${peakIdb.compactions.toString().padStart(13)}`,
		);
	}

	console.log();

	// ── Verdict ──────────────────────────────────────────────────────────────
	const compactedSizes = results.map((r) => r.afterCompact.docSize);
	const isMonotonic = compactedSizes.every(
		(size, i) => i === 0 || size >= compactedSizes[i - 1]!,
	);
	const maxGrowth = Math.max(...compactedSizes) - baselineDocSize;
	const maxGrowthPct = ((maxGrowth / baselineDocSize) * 100).toFixed(1);

	console.log(`${'═'.repeat(80)}`);
	console.log('  VERDICT');
	console.log(`${'═'.repeat(80)}`);
	console.log();
	console.log(
		`  Compacted IDB grows monotonically: ${isMonotonic ? 'YES ⚠️' : 'NO ✅'}`,
	);
	console.log(
		`  Max growth from baseline:          ${formatBytes(maxGrowth)} (${maxGrowthPct}%)`,
	);
	console.log(
		`  Baseline (${STEADY_STATE_ROWS} rows):               ${formatBytes(baselineDocSize)}`,
	);
	console.log(
		`  Final compacted size:              ${formatBytes(compactedSizes[compactedSizes.length - 1]!)}`,
	);
	console.log();

	if (isMonotonic && maxGrowth > 0) {
		console.log(`  ⚠️  The compacted size grows with every add/delete cycle.`);
		console.log(
			`  This is because Y.js keeps a state vector (client ID → clock)`,
		);
		console.log(
			`  that grows with each unique client. In this benchmark, all ops`,
		);
		console.log(
			`  are from the same client, so growth comes from the state vector`,
		);
		console.log(`  tracking higher clock values after more operations.`);
		console.log();
		console.log(
			`  With GC enabled (default), deleted content IS garbage collected,`,
		);
		console.log(
			`  but the state vector overhead is permanent and proportional to`,
		);
		console.log(`  the total number of operations ever performed.`);
	} else {
		console.log(`  ✅ The compacted size is stable across cycles.`);
		console.log(
			`  GC is working — deleted tombstones are cleaned up on compaction.`,
		);
	}

	console.log();

	// ── Bonus: What if we re-encode from snapshot? ──────────────────────────
	console.log(`${'─'.repeat(80)}`);
	console.log(
		'  BONUS: Fresh doc from snapshot (simulates "export + reimport")',
	);
	console.log(`${'─'.repeat(80)}`);
	const finalState = Y.encodeStateAsUpdate(ydoc);
	const freshDoc = new Y.Doc();
	Y.applyUpdate(freshDoc, finalState);
	const freshTables = {
		events: attachTable(freshDoc, 'events', eventDefinition),
	};
	const freshSize = Y.encodeStateAsUpdate(freshDoc).byteLength;

	console.log(
		`  Original doc:  ${formatBytes(finalState.byteLength)} (${tables.events.count()} rows)`,
	);
	console.log(
		`  Fresh doc:     ${formatBytes(freshSize)} (${freshTables.events.count()} rows)`,
	);
	console.log(
		`  Reduction:     ${((1 - freshSize / finalState.byteLength) * 100).toFixed(1)}%`,
	);
	console.log();

	ydoc.destroy();
	freshDoc.destroy();
}

main();
