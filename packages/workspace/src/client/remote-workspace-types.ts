/**
 * `Remote<T>` — derive the remote (RPC) call shape of an in-process workspace
 * by walking its type and keeping only branded `defineQuery` /
 * `defineMutation` leaves.
 *
 * The workspace is the action tree. There is no parallel contract. Pass the
 * full workspace type as `T` (typically `ReturnType<typeof openFuji>`) and
 * `Remote<T>` filters it to:
 *
 * - branded leaves at any depth become wire-callable and `Result`-wrapped
 *   via {@link WrapAction} (`Promise<Result<R, E | RpcError>>`)
 * - non-branded functions (plain methods, callbacks, class methods) drop
 * - objects containing no branded descendants drop
 * - `Y.Doc` and other class-instance properties drop because none of their
 *   own properties are branded
 *
 * Any value that doesn't pass through one of those branches drops. This
 * means a generic with no branded leaves yields an empty proxy: that is
 * the correct behavior, not a bug — see decision 7 in the companion spec.
 */

import type { Simplify } from '../shared/types.js';
import type { Action, WrapAction } from '../shared/actions.js';

/**
 * `true` if `T` is an object that contains at least one branded leaf, at
 * any depth. Used as the cut-line for whether a non-branded property
 * survives `Remote<T>`.
 *
 * Mutually recursive with {@link IsRemoteKey}. The `true extends ...`
 * trick collapses the union of per-key bools: any single `true` in the
 * map satisfies the constraint, so any branded descendant keeps the
 * ancestor.
 */
type HasBrandedLeaves<T> = T extends object
	? true extends { [K in keyof T]-?: IsRemoteKey<T[K]> }[keyof T]
		? true
		: false
	: false;

/**
 * `true` if `V` should appear on the remote. Branded actions are always
 * kept; plain functions (incl. class methods, getters returning callables)
 * are always dropped; objects are kept only when they recursively contain
 * a branded leaf.
 */
type IsRemoteKey<V> = V extends Action
	? true
	: V extends Function
		? false
		: V extends object
			? HasBrandedLeaves<V>
			: false;

/**
 * The remote-callable shape of `T`. Branded leaves are awaited and
 * `Result`-wrapped; non-branded keys drop.
 *
 * Wrapped in {@link Simplify} so IDE hover output shows the flattened
 * call shape rather than a wall of conditional types.
 */
export type Remote<T> = Simplify<{
	[K in keyof T as IsRemoteKey<T[K]> extends true ? K : never]: T[K] extends Action
		? WrapAction<T[K]>
		: T[K] extends object
			? Remote<T[K]>
			: never;
}>;
