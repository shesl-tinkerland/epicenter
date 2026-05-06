import type { DisposableCache } from '@epicenter/workspace';

/**
 * Component-scoped binding to a disposable cache. Opens a handle for the
 * current id and disposes it on unmount or id swap.
 *
 * Component-only: this helper uses `$effect`, so it must be called from a
 * `.svelte` component (or another `$effect` context). It cannot be called
 * from a `.svelte.ts` factory at module top.
 *
 * The id is read through `idFn` inside a `$derived`, so the handle tracks
 * prop/state changes. When the id changes, the cache opens a handle for the
 * new id and the effect's teardown disposes the handle for the old id.
 *
 * Why a getter (`() => id`) and not the id directly: destructured props and
 * `$state` reads are not reactive when captured at module top. See Svelte's
 * `state_referenced_locally` warning. Passing a function keeps the read
 * inside the derived's closure.
 */
export function useCacheHandle<
	TId extends string | number,
	TValue extends Disposable,
>(
	cache: DisposableCache<TId, TValue>,
	idFn: () => TId,
): { readonly current: TValue } {
	const handle = $derived(cache.open(idFn()));
	$effect(() => {
		const handleToDispose = handle;
		return () => handleToDispose[Symbol.dispose]();
	});
	return {
		get current() {
			return handle;
		},
	};
}
