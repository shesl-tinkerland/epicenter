/**
 * `createDisposableCache`: refcounted cache for disposable resources.
 *
 * Same id → same instance shared across consumers; teardown is debounced after
 * the last consumer leaves. Solves three coupled problems:
 *
 * 1. **Concurrent consumers of the same id must share ONE instance.** Otherwise
 *    local state diverges: two editors mounted on the same Y.Doc would only
 *    see each other's edits after a sync round-trip.
 * 2. **Sequential mount/unmount shouldn't rebuild expensive resources.**
 *    Route swaps, HMR, conditional rendering, split-pane close-then-reopen all
 *    produce rapid open→close→open sequences. `gcTime` keeps the instance
 *    alive briefly so the next `open` can reuse it.
 * 3. **Page exit / workspace teardown needs explicit disposal.** The cache
 *    itself is `Disposable`; `cache[Symbol.dispose]()` flushes every entry.
 *
 * The value type is opaque: anything `Disposable`. Y.Docs are the most common
 * case in this codebase; audio decoders, worker connections, MediaStreams, and
 * native window handles fit the same shape and should use this primitive
 * rather than reinventing refcount+grace.
 *
 * ## Usage
 *
 * ```ts
 * const cache = createDisposableCache(
 *   (id: string) => buildExpensiveThing(id),
 *   { gcTime: 5_000 },
 * );
 *
 * // Two concurrent consumers of the same id share one instance.
 * const a = cache.open('thing-1');
 * const b = cache.open('thing-1');
 * // a and b are different handles, but a.value === b.value
 *
 * a[Symbol.dispose]();  // refcount: 2 → 1
 * b[Symbol.dispose]();  // refcount: 1 → 0; teardown armed for 5s
 *
 * // Reactive pattern: open in $effect, dispose in cleanup. Re-opening within
 * // 5s cancels the pending teardown.
 * $effect(() => {
 *   const handle = cache.open(id);
 *   return () => handle[Symbol.dispose]();
 * });
 *
 * // Workspace teardown: flush everything immediately.
 * cache[Symbol.dispose]();
 * ```
 *
 * ## What this primitive does NOT do
 *
 * - **No async builder.** Construction is synchronous. If your `T` needs async
 *   readiness, expose a `whenReady: Promise<unknown>` field on it; the cache
 *   stays sync, readiness is a value-level concern.
 * - **No max size / LRU eviction.** Out of scope; add when needed.
 * - **No per-id force-close.** One way to release a handle: dispose it. Two
 *   ways means call sites that mismatch open/close.
 * - **No subscriptions / change events.** Just construct, share, dispose.
 *
 * @module
 */

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';

/** Errors surfaced by the cache's background disposal machinery. */
export const DisposableCacheError = defineErrors({
	/**
	 * The user-supplied value's `[Symbol.dispose]` raised. The entry is already
	 * removed from the cache; the throw is informational.
	 */
	ValueDisposeThrew: ({ cause }: { cause: unknown }) => ({
		message: `[createDisposableCache] value [Symbol.dispose]() threw: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type DisposableCacheError = InferErrors<typeof DisposableCacheError>;

/**
 * Refcounted cache returned by `createDisposableCache`. Itself `Disposable`
 * `cache[Symbol.dispose]()` flushes every entry immediately.
 */
export interface DisposableCache<Id, T> extends Disposable {
	/**
	 * Open a handle. Increments the refcount for `id`. The returned handle
	 * prototype-chains to the underlying `T`, plus its own `[Symbol.dispose]`
	 * that decrements *this handle's* refcount: it does NOT destroy the
	 * underlying `T` directly. The underlying `T[Symbol.dispose]()` is called
	 * once, by the cache, when the refcount reaches zero after `gcTime`.
	 *
	 * Each call returns a distinct handle. N opens require N disposes.
	 */
	open(id: Id): T & Disposable;
	/** Whether an instance is currently held (refcounted or in grace window). */
	has(id: Id): boolean;
}

type CacheEntry<T extends Disposable> = {
	value: T;
	openCount: number;
	gcTimer: ReturnType<typeof setTimeout> | null;
	disposed: boolean;
};

/**
 * Create a refcounted cache for disposable resources.
 *
 * @param build - Closure invoked on cache miss. Returns a `T extends Disposable`.
 *                Runs synchronously; if it throws, the cache is unchanged
 *                (next `open(sameId)` re-runs the closure: no poisoned entry).
 * @param opts  - `gcTime` (default `5_000`ms): milliseconds to wait after the
 *                refcount reaches zero before tearing down the underlying value.
 *                `0` = synchronous teardown, no timer. `Infinity` = never
 *                auto-evict; only `cache[Symbol.dispose]()` can force teardown.
 *                A fresh `open` during the grace window cancels the pending
 *                teardown.
 */
export function createDisposableCache<
	Id extends string | number,
	T extends Disposable,
>(
	build: (id: Id) => T,
	{
		gcTime = 5_000,
		log = createLogger('createDisposableCache'),
	}: { gcTime?: number; log?: Logger } = {},
): DisposableCache<Id, T> {
	const entries = new Map<Id, CacheEntry<T>>();

	function disposeEntry(id: Id, entry: CacheEntry<T>): void {
		entry.disposed = true;
		if (entry.gcTimer !== null) {
			clearTimeout(entry.gcTimer);
			entry.gcTimer = null;
		}
		// Remove from cache synchronously so a concurrent `open()` constructs a
		// fresh entry rather than handing out the about-to-be-destroyed one.
		if (entries.get(id) === entry) {
			entries.delete(id);
		}
		try {
			entry.value[Symbol.dispose]();
		} catch (cause) {
			log.error(DisposableCacheError.ValueDisposeThrew({ cause }));
		}
	}

	const cache: DisposableCache<Id, T> = {
		open(id) {
			let entry = entries.get(id);
			if (entry === undefined) {
				// User closure runs synchronously. If it throws, we DON'T insert
				// into the cache: next `open(sameId)` re-runs the closure (no
				// poisoned entry). The caller sees the thrown error.
				const value = build(id);
				entry = { value, openCount: 0, gcTimer: null, disposed: false };
				entries.set(id, entry);
			}

			if (entry.gcTimer !== null) {
				clearTimeout(entry.gcTimer);
				entry.gcTimer = null;
			}
			entry.openCount++;

			let handleDisposed = false;
			const dispose = (): void => {
				if (handleDisposed) return;
				handleDisposed = true;
				if (entry.disposed) return;
				entry.openCount--;
				if (entry.openCount !== 0) return;

				if (gcTime === 0) {
					disposeEntry(id, entry);
					return;
				}
				if (gcTime === Number.POSITIVE_INFINITY) {
					// Never auto-evict; entry stays live until cache[Symbol.dispose]().
					return;
				}
				entry.gcTimer = setTimeout(() => {
					entry.gcTimer = null;
					disposeEntry(id, entry);
				}, gcTime);
			};

			// Prototype-chain shallow wrapper. Reads of `T`'s properties fall
			// through to the underlying value; writes to the handle don't leak
			// between consumers; `[Symbol.dispose]` is shadowed to call the
			// per-handle dispose, not the underlying value's destroy.
			return {
				...entry.value,
				[Symbol.dispose]: dispose,
			} as T & Disposable;
		},

		has(id) {
			return entries.has(id);
		},

		[Symbol.dispose]() {
			const snapshot = Array.from(entries.entries());
			entries.clear();
			for (const [id, entry] of snapshot) disposeEntry(id, entry);
		},
	};

	return cache;
}
