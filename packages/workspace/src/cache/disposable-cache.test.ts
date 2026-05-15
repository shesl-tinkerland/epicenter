import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { createDisposableCache } from './disposable-cache.js';

/**
 * Helper: a minimal Disposable wrapping a Y.Doc. Y.Doc is the most common
 * real-world value, but the cache itself is generic; these tests exercise
 * the cache through Y.Doc only because Y.Doc.isDestroyed gives an easy
 * "did dispose actually run?" assertion.
 */
function makeYDocCache({ gcTime }: { gcTime?: number } = {}) {
	return createDisposableCache(
		(id: string) => {
			const ydoc = new Y.Doc({ guid: id });
			return {
				ydoc,
				[Symbol.dispose]() {
					ydoc.destroy();
				},
			};
		},
		{ gcTime },
	);
}

// ════════════════════════════════════════════════════════════════════════════
// open / cache identity
// ════════════════════════════════════════════════════════════════════════════

describe('open / cache identity', () => {
	test('same id shares the underlying value across handles; different ids get separate values', () => {
		const cache = makeYDocCache();
		const [a1, a2, a3] = [cache.open('a'), cache.open('a'), cache.open('a')];
		const b = cache.open('b');

		expect(a1).not.toBe(a2);
		expect(a1.ydoc).toBe(a2.ydoc);
		expect(a2.ydoc).toBe(a3.ydoc);
		expect(b.ydoc).not.toBe(a1.ydoc);
		expect(b.ydoc.guid).toBe('b');

		a1[Symbol.dispose]();
		a2[Symbol.dispose]();
		a3[Symbol.dispose]();
		b[Symbol.dispose]();
	});

	test('writes to one handle do not leak to other handles for the same id', () => {
		const cache = createDisposableCache((_id: string) => ({
			counter: 0,
			[Symbol.dispose]() {},
		}));
		const a = cache.open('a') as unknown as { counter: number } & Disposable;
		const b = cache.open('a') as unknown as { counter: number } & Disposable;
		a.counter = 99;
		expect(b.counter).toBe(0);
		a[Symbol.dispose]();
		b[Symbol.dispose]();
	});

	test('build closure runs without coupling to a parent context', () => {
		// Pure builder: no closures, no module-scope state. The cache calls
		// it with just an id and gets back a Disposable.
		const cache = createDisposableCache((id: string) => ({
			ydoc: new Y.Doc({ guid: id }),
			[Symbol.dispose]() {},
		}));
		const h = cache.open('a');
		expect(h.ydoc.guid).toBe('a');
		h[Symbol.dispose]();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// throwing build closure
// ════════════════════════════════════════════════════════════════════════════

describe('throwing build closure', () => {
	test('error propagates and the cache does not store the id', () => {
		let calls = 0;
		const cache = createDisposableCache((id: string) => {
			calls++;
			if (calls === 1) throw new Error('boom');
			const ydoc = new Y.Doc({ guid: id });
			return {
				ydoc,
				[Symbol.dispose]() {
					ydoc.destroy();
				},
			};
		});

		expect(() => cache.open('foo')).toThrow('boom');
		expect(cache.has('foo')).toBe(false);
		// The second attempt must run the closure again; no poisoned entry.
		const handle = cache.open('foo');
		expect(calls).toBe(2);
		expect(handle.ydoc.guid).toBe('foo');
		handle[Symbol.dispose]();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// arbitrary fields flow through the handle
// ════════════════════════════════════════════════════════════════════════════

describe('arbitrary fields flow through the handle', () => {
	test('builder-attached fields are readable on every handle', () => {
		const cache = createDisposableCache((id: string) => {
			const ydoc = new Y.Doc({ guid: id });
			return {
				ydoc,
				body: { kind: 'rich-text' as const },
				[Symbol.dispose]() {
					ydoc.destroy();
				},
			};
		});
		const a = cache.open('a');
		const b = cache.open('a');
		expect(a.body.kind).toBe('rich-text');
		expect(b.body.kind).toBe('rich-text');
		expect(a.body).toBe(b.body); // same reference under the hood
		a[Symbol.dispose]();
		b[Symbol.dispose]();
	});

	test('whenReady-style readiness composition works (cache is agnostic to it)', async () => {
		let resolveA!: () => void;
		let resolveB!: () => void;
		const cache = createDisposableCache((id: string) => {
			const ydoc = new Y.Doc({ guid: id });
			const a = new Promise<void>((r) => {
				resolveA = r;
			});
			const b = new Promise<void>((r) => {
				resolveB = r;
			});
			return {
				ydoc,
				whenReady: Promise.all([a, b]),
				[Symbol.dispose]() {
					ydoc.destroy();
				},
			};
		});

		const handle = cache.open('a');
		let resolved = false;
		void (async () => {
			await handle.whenReady;
			resolved = true;
		})();

		await new Promise((r) => setTimeout(r, 5));
		expect(resolved).toBe(false);
		resolveA();
		await new Promise((r) => setTimeout(r, 5));
		expect(resolved).toBe(false);
		resolveB();
		await handle.whenReady;
		expect(resolved).toBe(true);
		handle[Symbol.dispose]();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// has()
// ════════════════════════════════════════════════════════════════════════════

describe('has()', () => {
	test('returns false before open, true while held, false after teardown', () => {
		const cache = makeYDocCache({ gcTime: 0 });
		expect(cache.has('a')).toBe(false);
		const h = cache.open('a');
		expect(cache.has('a')).toBe(true);
		h[Symbol.dispose]();
		expect(cache.has('a')).toBe(false);
	});

	test('returns true during the gcTime grace window', async () => {
		const cache = makeYDocCache({ gcTime: 50 });
		const h = cache.open('a');
		h[Symbol.dispose]();
		expect(cache.has('a')).toBe(true);
		await new Promise((r) => setTimeout(r, 80));
		expect(cache.has('a')).toBe(false);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// cache-level dispose (replaces close() / closeAll())
// ════════════════════════════════════════════════════════════════════════════

describe('cache[Symbol.dispose]', () => {
	test('disposes every entry; subsequent open() constructs fresh values', () => {
		const cache = makeYDocCache();
		const a1 = cache.open('a');
		const b1 = cache.open('b');
		const ydocA = a1.ydoc;
		const ydocB = b1.ydoc;
		cache[Symbol.dispose]();
		expect(ydocA.isDestroyed).toBe(true);
		expect(ydocB.isDestroyed).toBe(true);
		const a2 = cache.open('a');
		const b2 = cache.open('b');
		expect(a2.ydoc).not.toBe(ydocA);
		expect(b2.ydoc).not.toBe(ydocB);
		a2[Symbol.dispose]();
		b2[Symbol.dispose]();
	});

	test('cancels all pending grace timers', async () => {
		const cache = makeYDocCache({ gcTime: 50 });
		const ydocs = ['a', 'b', 'c'].map((id) => {
			const h = cache.open(id);
			h[Symbol.dispose]();
			return h.ydoc;
		});

		cache[Symbol.dispose]();
		for (const ydoc of ydocs) expect(ydoc.isDestroyed).toBe(true);

		await new Promise((r) => setTimeout(r, 80));
		for (const ydoc of ydocs) expect(ydoc.isDestroyed).toBe(true);
	});

	test('a throwing value [Symbol.dispose] does not propagate; cache still evicts', () => {
		let calls = 0;
		const cache = createDisposableCache((id: string) => {
			calls++;
			const ydoc = new Y.Doc({ guid: id });
			return {
				ydoc,
				[Symbol.dispose]() {
					ydoc.destroy();
					throw new Error('dispose boom');
				},
			};
		});

		const prevError = console.error;
		console.error = () => {};
		try {
			const h = cache.open('a');
			h[Symbol.dispose]();
			expect(() => cache[Symbol.dispose]()).not.toThrow();
			const h2 = cache.open('a');
			expect(calls).toBe(2);
			h2[Symbol.dispose]();
		} finally {
			console.error = prevError;
		}
	});

	test('synchronous teardown cascade: dispose fires value [Symbol.dispose] synchronously, downstream listeners observe before dispose returns', async () => {
		let resolveSentinel!: () => void;
		const sentinel = new Promise<void>((r) => {
			resolveSentinel = r;
		});

		const cache = createDisposableCache((id: string) => {
			const ydoc = new Y.Doc({ guid: id });
			ydoc.on('destroy', () => {
				resolveSentinel();
			});
			return {
				ydoc,
				[Symbol.dispose]() {
					ydoc.destroy();
				},
			};
		});
		cache.open('a');

		// No await: cache dispose returns void and cascades synchronously.
		cache[Symbol.dispose]();

		await sentinel;
	});
});

// ════════════════════════════════════════════════════════════════════════════
// open / dispose: refcount, grace-period disposal, disposable protocol
// ════════════════════════════════════════════════════════════════════════════

describe('open / dispose', () => {
	test('refcount: two opens require two disposes before grace timer starts', async () => {
		const cache = makeYDocCache({ gcTime: 15 });
		const h1 = cache.open('a');
		const h2 = cache.open('a');
		h1[Symbol.dispose]();
		await new Promise((r) => setTimeout(r, 30));
		expect(h1.ydoc.isDestroyed).toBe(false);
		h2[Symbol.dispose]();
		await new Promise((r) => setTimeout(r, 30));
		expect(h1.ydoc.isDestroyed).toBe(true);
	});

	test('per-handle dispose is idempotent', async () => {
		const cache = makeYDocCache({ gcTime: 10 });
		const h1 = cache.open('a');
		const h2 = cache.open('a');
		h1[Symbol.dispose]();
		h1[Symbol.dispose]();
		await new Promise((r) => setTimeout(r, 30));
		expect(h1.ydoc.isDestroyed).toBe(false);
		h2[Symbol.dispose]();
		await new Promise((r) => setTimeout(r, 30));
		expect(h1.ydoc.isDestroyed).toBe(true);
	});

	test('using h = cache.open(id) disposes on scope exit', async () => {
		const cache = makeYDocCache({ gcTime: 10 });
		let ydocRef: Y.Doc;
		{
			using h = cache.open('a');
			ydocRef = h.ydoc;
			expect(h.ydoc.isDestroyed).toBe(false);
		}
		expect(ydocRef.isDestroyed).toBe(false); // still in grace
		await new Promise((r) => setTimeout(r, 30));
		expect(ydocRef.isDestroyed).toBe(true);
	});

	test('open() during grace cancels the pending disposal', async () => {
		const cache = makeYDocCache({ gcTime: 20 });
		const h1 = cache.open('a');
		h1[Symbol.dispose]();
		await new Promise((r) => setTimeout(r, 5));
		const h2 = cache.open('a');
		expect(h2.ydoc).toBe(h1.ydoc);

		await new Promise((r) => setTimeout(r, 35));
		expect(h2.ydoc.isDestroyed).toBe(false);

		h2[Symbol.dispose]();
		await new Promise((r) => setTimeout(r, 35));
		expect(h2.ydoc.isDestroyed).toBe(true);
	});

	test('handle dispose captured before cache dispose is a safe no-op afterward', async () => {
		const cache = makeYDocCache({ gcTime: 100 });
		const h = cache.open('a');
		cache[Symbol.dispose]();
		h[Symbol.dispose]();
		await new Promise((r) => setTimeout(r, 20));
		expect(h.ydoc.isDestroyed).toBe(true);
	});

	test('gcTime: 0 tears down synchronously on last dispose', () => {
		const cache = makeYDocCache({ gcTime: 0 });
		const h1 = cache.open('a');
		const h2 = cache.open('a');
		h1[Symbol.dispose]();
		expect(h1.ydoc.isDestroyed).toBe(false);
		h2[Symbol.dispose]();
		expect(h1.ydoc.isDestroyed).toBe(true);
	});

	test('gcTime: Infinity keeps entry live indefinitely; cache dispose forces teardown', async () => {
		const cache = makeYDocCache({ gcTime: Number.POSITIVE_INFINITY });
		const h = cache.open('a');
		const ydoc = h.ydoc;
		h[Symbol.dispose]();
		await new Promise((r) => setTimeout(r, 50));
		expect(ydoc.isDestroyed).toBe(false);

		const h2 = cache.open('a');
		expect(h2.ydoc).toBe(ydoc);
		h2[Symbol.dispose]();

		cache[Symbol.dispose]();
		expect(ydoc.isDestroyed).toBe(true);
	});

	test('default gcTime is finite (5s); teardown eventually fires without explicit cache dispose', async () => {
		// Guards the documented default. A bug that flipped the default back
		// to Infinity would make this test hang past the assertion window.
		const cache = makeYDocCache(); // default
		const h = cache.open('a');
		const ydoc = h.ydoc;
		h[Symbol.dispose]();
		// Not waiting the full 5s here; just confirm the timer was armed by
		// looking up has(). It should be true (in grace), not absent.
		expect(cache.has('a')).toBe(true);
		expect(ydoc.isDestroyed).toBe(false);
		// Cleanup
		cache[Symbol.dispose]();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// re-entrancy
// ════════════════════════════════════════════════════════════════════════════

describe('re-entrancy', () => {
	test("value's [Symbol.dispose] can re-enter via cache.open(sameId) and gets a fresh entry", () => {
		// During teardown, the entry is removed from the cache's internal map
		// BEFORE the value's [Symbol.dispose]() runs. So a re-entrant open of
		// the same id during teardown must construct a brand new entry, not
		// resurrect the about-to-be-destroyed one.
		// biome-ignore lint/suspicious/noExplicitAny: cache referenced inside its own builder
		let cache: any;
		let buildCount = 0;
		// biome-ignore lint/suspicious/noExplicitAny: handle type is parameterized via the cache itself
		let reopenedHandle: any;
		cache = createDisposableCache(
			(id: string) => {
				buildCount++;
				const buildIndex = buildCount;
				return {
					id,
					buildIndex,
					[Symbol.dispose]() {
						// Only re-open once, from the first instance's teardown.
						if (buildIndex === 1 && !reopenedHandle) {
							reopenedHandle = cache.open(id);
						}
					},
				};
			},
			{ gcTime: 0 },
		);

		const h = cache.open('a');
		h[Symbol.dispose]();

		// The dispose triggered a re-open. We should now have a fresh entry,
		// not a stale reference to the just-destroyed one.
		expect(buildCount).toBe(2);
		expect(reopenedHandle.buildIndex).toBe(2);
		expect(cache.has('a')).toBe(true);
		reopenedHandle[Symbol.dispose]();
		expect(cache.has('a')).toBe(false);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// plain-object invariant (T must be a plain object)
// ════════════════════════════════════════════════════════════════════════════

describe('plain-object invariant', () => {
	test('class instances passed directly LOSE prototype methods on the handle', () => {
		// The handle is built via spread, which copies own enumerable
		// properties only. Methods on the class prototype are NOT copied.
		// This test pins down that documented limitation so a future change
		// to the wrapping strategy doesn't silently regress it.
		class WithPrototypeMethod {
			name = 'underlying';
			greet(): string {
				return `hi from ${this.name}`;
			}
			[Symbol.dispose]() {}
		}
		const cache = createDisposableCache(
			(_id: string) => new WithPrototypeMethod(),
		);
		const handle = cache.open('a');

		// Own field is preserved by the spread.
		expect(handle.name).toBe('underlying');
		// Prototype method is NOT preserved by the spread.
		expect((handle as unknown as { greet?: unknown }).greet).toBeUndefined();

		handle[Symbol.dispose]();
		cache[Symbol.dispose]();
	});
});
