import { Ok, type Result } from 'wellcrafted/result';
import type { AppConfig } from './config.ts';
import type { BooksDb, MirrorRow, SyncStateRow } from './db.ts';
import {
	type EntityDef,
	entityDef,
	isDeleted,
	lastUpdatedTime,
	type QbObject,
} from './entities.ts';
import type { QbClient, QbClientError } from './qb-client.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

export type SyncMode = 'FULL' | 'INCREMENTAL';

export type ModeDecision = { mode: SyncMode; reason: string };

export type ModeInputs = {
	forceFull: boolean;
	syncState: SyncStateRow | null;
	now: number;
	cdcSafeWindowDays: number;
	fullBackstopDays: number;
};

/**
 * Choose FULL vs INCREMENTAL from stored state alone (pure, so it is unit
 * testable without a network). FULL wins whenever incremental cannot be trusted:
 * an explicit `--full`, no cursor yet, a cursor older than the CDC lookback
 * window (the gap is unrecoverable), or a stale last-full-pull backstop.
 */
export function decideMode({
	forceFull,
	syncState,
	now,
	cdcSafeWindowDays,
	fullBackstopDays,
}: ModeInputs): ModeDecision {
	if (forceFull) return { mode: 'FULL', reason: 'forced (--full)' };

	const cursor = syncState?.cdcCursor;
	if (!cursor) return { mode: 'FULL', reason: 'no cursor (first run)' };

	const cursorAgeDays = (now - Date.parse(cursor)) / DAY_MS;
	if (cursorAgeDays > cdcSafeWindowDays) {
		return {
			mode: 'FULL',
			reason: `cursor ${cursorAgeDays.toFixed(1)}d old exceeds ${cdcSafeWindowDays}d CDC window`,
		};
	}

	const lastFull = syncState?.lastFullPullAt;
	if (!lastFull) return { mode: 'FULL', reason: 'no recorded full pull' };

	const fullAgeDays = (now - Date.parse(lastFull)) / DAY_MS;
	if (fullAgeDays > fullBackstopDays) {
		return {
			mode: 'FULL',
			reason: `last full pull ${fullAgeDays.toFixed(1)}d old exceeds ${fullBackstopDays}d backstop`,
		};
	}

	return {
		mode: 'INCREMENTAL',
		reason: `cursor ${cursorAgeDays.toFixed(1)}d old, within window`,
	};
}

export type SyncEntityResult = {
	entity: string;
	mode: SyncMode;
	reason: string;
	upserted: number;
	deleted: number;
	cursorBefore: string | null;
	cursorAfter: string;
};

export type SyncDeps = {
	db: BooksDb;
	client: QbClient;
	config: AppConfig;
	now: () => number;
	log?: (message: string) => void;
};

/** Split a batch of QB objects into live upserts and soft-deletes. */
function partition(objects: QbObject[]): {
	upserts: MirrorRow[];
	deletes: MirrorRow[];
} {
	const upserts: MirrorRow[] = [];
	const deletes: MirrorRow[] = [];
	for (const obj of objects) {
		const id = obj.Id != null ? String(obj.Id) : null;
		if (!id) continue; // skip malformed objects with no Id
		const raw = JSON.stringify(obj);
		const updatedAt = lastUpdatedTime(obj);
		if (isDeleted(obj)) {
			deletes.push({ id, raw, updatedAt });
		} else {
			upserts.push({ id, raw, updatedAt });
		}
	}
	return { upserts, deletes };
}

export async function syncEntity(
	deps: SyncDeps,
	def: EntityDef,
	{ forceFull }: { forceFull: boolean },
): Promise<Result<SyncEntityResult, QbClientError>> {
	const { db, client, config, now } = deps;
	const log = deps.log ?? (() => {});

	const state = db.readSyncState(def.name);
	const nowMs = now();
	const { mode, reason } = decideMode({
		forceFull,
		syncState: state,
		now: nowMs,
		cdcSafeWindowDays: config.cdcSafeWindowDays,
		fullBackstopDays: config.fullBackstopDays,
	});
	const cursorBefore = state?.cdcCursor ?? null;
	// Next run's cursor is the moment THIS run started: any object changed while
	// the pull runs is re-fetched next time. Idempotent upserts make the overlap
	// harmless; the alternative (server time at end of pull) risks a lost edit.
	const cursorAfter = new Date(nowMs).toISOString();

	log(`${def.name}: ${mode} (${reason})`);

	let objects: QbObject[];
	if (mode === 'FULL') {
		const pulled = await client.queryAll(def.name);
		if (pulled.error) return pulled;
		objects = pulled.data;
	} else {
		// cursorBefore is non-null here: a null cursor forces FULL above.
		const changed = await client.cdc([def.name], cursorBefore as string);
		if (changed.error) return changed;
		objects = changed.data.changes[def.name] ?? [];
	}

	const { upserts, deletes } = partition(objects);

	const newState: SyncStateRow = {
		entity: def.name,
		cdcCursor: cursorAfter,
		lastFullPullAt:
			mode === 'FULL' ? cursorAfter : (state?.lastFullPullAt ?? null),
		lastSyncedAt: cursorAfter,
	};

	db.applyEntitySync(def, {
		upserts,
		deletes,
		syncState: newState,
		syncedAt: cursorAfter,
	});

	return Ok({
		entity: def.name,
		mode,
		reason,
		upserted: upserts.length,
		deleted: deletes.length,
		cursorBefore,
		cursorAfter,
	});
}

export type SyncAllOutcome = {
	results: SyncEntityResult[];
	failures: { entity: string; error: QbClientError }[];
};

/**
 * Sync each configured entity in turn. Entities run sequentially to stay well
 * under the 500 req/min + 10-concurrent QuickBooks limits; one entity's failure
 * is recorded but does not abort the rest.
 */
export async function syncAll(
	deps: SyncDeps,
	{ forceFull, entities }: { forceFull: boolean; entities: string[] },
): Promise<SyncAllOutcome> {
	const results: SyncEntityResult[] = [];
	const failures: { entity: string; error: QbClientError }[] = [];

	for (const name of entities) {
		const def = entityDef(name);
		const { data, error } = await syncEntity(deps, def, { forceFull });
		if (error) {
			failures.push({ entity: name, error });
		} else {
			results.push(data);
		}
	}

	return { results, failures };
}

export type SyncLoopOptions = {
	forceFull: boolean;
	entities: string[];
	intervalMs: number;
	/** Aborting the signal stops the loop after the current pass or sleep. */
	signal: AbortSignal;
	/** Called after each pass with its outcome and 1-based pass number. */
	onPass?: (outcome: SyncAllOutcome, pass: number) => void;
};

/**
 * A sleep that resolves early when the signal aborts, so Ctrl-C is instant. The
 * abort listener is removed on the timeout path too: without that, a long-lived
 * loop would leak one dangling listener per pass.
 */
function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

/**
 * Run `syncAll` on a loop until the signal aborts. The first pass honors
 * `forceFull`; every later pass is incremental (the cursor has advanced), so
 * `--full --interval` means "one full pull, then keep up with CDC".
 */
export async function runSyncLoop(
	deps: SyncDeps,
	opts: SyncLoopOptions,
): Promise<void> {
	let pass = 0;
	while (!opts.signal.aborted) {
		const outcome = await syncAll(deps, {
			forceFull: opts.forceFull && pass === 0,
			entities: opts.entities,
		});
		pass += 1;
		opts.onPass?.(outcome, pass);
		if (opts.signal.aborted) break;
		await interruptibleSleep(opts.intervalMs, opts.signal);
	}
}
