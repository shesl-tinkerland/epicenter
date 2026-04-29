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
 * - `Y.Doc` and other class-instance properties drop because they bottom
 *   out before reaching a branded leaf — see the depth bound below
 *
 * ## The depth bound
 *
 * Class instances like `Y.Doc` carry circular type references (`Doc._item.parent.doc.…`)
 * that send a naive recursive mapped type into TS2615 ("circularly references
 * itself"). The `Depth` parameter is a tuple-length counter: every recursion
 * appends a `1` and bails when it hits `MAX_DEPTH`. Eight levels is enough
 * for any realistic workspace tree (`tables.<name>.<verb>` is depth 3) and
 * short enough to keep tsc fast and forget about Y.Doc's internal graph.
 */

import type { Simplify } from '../shared/types.js';
import type { Action, WrapAction } from '../shared/actions.js';

/**
 * Recursion depth bound for `Remote<T>` and its helpers. Counted as a
 * tuple length: 8 levels covers every realistic workspace nesting and
 * keeps the recursion bounded for class-instance properties.
 */
type MaxDepth = [1, 1, 1, 1, 1, 1, 1, 1];

type Inc<D extends ReadonlyArray<1>> = [...D, 1];
type AtLimit<D extends ReadonlyArray<1>> = D['length'] extends MaxDepth['length']
	? true
	: false;

/**
 * `true` if `T` is an object that contains at least one branded leaf at any
 * depth ≤ remaining `Depth` budget. Used as the cut-line for whether a
 * non-branded property survives `Remote<T>`.
 */
type HasBrandedLeaves<T, D extends ReadonlyArray<1>> = AtLimit<D> extends true
	? false
	: T extends object
		? true extends {
				[K in keyof T]-?: IsRemoteKey<T[K], Inc<D>>;
			}[keyof T]
			? true
			: false
		: false;

/**
 * `true` if `V` should appear on the remote. Branded actions are always
 * kept; plain functions are always dropped; objects are kept only when
 * they recursively contain a branded leaf within the depth budget.
 */
type IsRemoteKey<V, D extends ReadonlyArray<1>> = V extends Action
	? true
	: V extends Function
		? false
		: V extends object
			? HasBrandedLeaves<V, D>
			: false;

/**
 * The remote-callable shape of `T`. Branded leaves are awaited and
 * `Result`-wrapped; non-branded keys drop. Bounded recursion depth so
 * class-instance properties (Y.Doc, arktype Type, etc.) drop cleanly
 * without hitting TS2615.
 *
 * Wrapped in {@link Simplify} so IDE hover output shows the flattened
 * call shape rather than a wall of conditional types.
 */
export type Remote<T, D extends ReadonlyArray<1> = []> = AtLimit<D> extends true
	? {}
	: Simplify<{
			[K in keyof T as IsRemoteKey<T[K], D> extends true
				? K
				: never]: T[K] extends Action
				? WrapAction<T[K]>
				: T[K] extends object
					? Remote<T[K], Inc<D>>
					: never;
		}>;
