/**
 * Trailing-edge debounce.
 *
 * Wrap `fn` so it runs only after `ms` have elapsed since the most recent
 * call. Each call restarts the timer, and the last call's arguments win.
 * The wrapper returns `void`: a debounced call has no result to await,
 * even when `fn` is async (the returned promise is left to settle on its
 * own, exactly as a bare `setTimeout` callback would be).
 *
 * Call `.cancel()` to drop a pending run without firing it, e.g. from a
 * `[Symbol.dispose]` or other teardown path.
 */

/**
 * Wrap `fn` in a trailing-edge debounce of `ms` milliseconds.
 *
 * @example
 * ```ts
 * const save = debounce((draft: string) => persist(draft), 300);
 * save('a');
 * save('ab');     // only 'ab' persists, 300ms after this call
 * save.cancel();  // ...unless cancelled first
 * ```
 */
export function debounce<TArgs extends readonly unknown[]>(
	fn: (...args: TArgs) => unknown,
	ms: number,
): {
	(...args: TArgs): void;
	/** Drop a pending run without firing it. No-op when nothing is pending. */
	cancel(): void;
} {
	let timer: ReturnType<typeof setTimeout> | undefined;

	function debounced(...args: TArgs): void {
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			fn(...args);
		}, ms);
	}

	debounced.cancel = (): void => {
		if (timer === undefined) return;
		clearTimeout(timer);
		timer = undefined;
	};

	return debounced;
}
