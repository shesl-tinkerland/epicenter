/**
 * Actions: typed queries (reads) and mutations (writes) authored as a nested
 * tree of closures. `defineQuery`/`defineMutation` attach metadata to the
 * handler and return it: the action callable IS the handler, so local
 * callers see exactly what the author wrote (sync stays sync, `Result` stays
 * `Result`).
 *
 * Two shapes for the same data:
 *
 *     Actions                       ←→     ActionManifest
 *     nested, callable                     flat, metadata-only
 *     local, in-memory                     wire form (system.describe)
 *
 *     {                                    {
 *       tabs: { close: Mutation },           "tabs.close": { type, ... },
 *       ping: Query,                         "ping":       { type, ... },
 *     }                                    }
 *
 * Functions don't serialize, so the wire form drops them and keeps just the
 * metadata. Both shapes are public; `describeActions(tree)` converts.
 * `walkActions(tree)` is the underlying iterator: yields live `[path, Action]`
 * pairs for callers that want to filter, invoke, or count instead of
 * materializing the full record.
 *
 * Transport boundaries (RPC server-side, CLI dispatch, AI bridge) normalize
 * any handler return into `Promise<Result<T, RpcError>>` via
 * `invokeAction`. The wire client (`RemoteActions`) re-types each leaf
 * to that uniform shape. Local UI code that wants `Result` either calls
 * `tryAsync` or defines the handler to return `Result` explicitly.
 *
 * @module
 */

import type { Static, TSchema } from 'typebox';
import type { Result } from 'wellcrafted/result';
import { Ok, isResult } from 'wellcrafted/result';
import { RpcError } from './rpc-errors';

// ════════════════════════════════════════════════════════════════════════════
// ACTION DEFINITION TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * The handler function type, conditional on whether input is provided.
 *
 * Uses variadic tuple args instead of conditional function signatures so that
 * when the type flows through `Action` (via the `Actions` constraint), `any`
 * distributes over both branches giving `[input: any] | []`: which correctly
 * allows calling with 0 arguments for no-input actions.
 *
 * Parameterized on `R` (the handler's actual return type) rather than splitting
 * `TOutput`/`TError`: keeps the action's callable signature exactly equal to
 * the handler's, so passthrough preserves precision (no widening to a
 * `T | Result<T, E> | Promise<...>` union).
 */
type ActionHandler<
	TInput extends TSchema | undefined = TSchema | undefined,
	R = unknown,
> = (
	...args: TInput extends TSchema ? [input: Static<TInput>] : []
) => R;

/**
 * Configuration for defining an action (query or mutation).
 */
type ActionConfig<TInput extends TSchema | undefined, R> = {
	/** Short, human-readable display name for UI surfaces (e.g. 'Close Tabs'). Falls back to path-derived name if omitted. */
	title?: string;
	description?: string;
	input?: TInput;
	handler: ActionHandler<TInput, R>;
};

/**
 * Metadata properties attached to a callable action.
 *
 * `input` (a live `TSchema`) is present whenever the action defines one.
 * Action discovery returns this shape directly: there is no separate
 * wire form.
 */
export type ActionMeta<TInput extends TSchema | undefined = TSchema | undefined> = {
	type: 'query' | 'mutation';
	/** Short, human-readable display name for UI surfaces (e.g. 'Close Tabs'). Falls back to path-derived name if omitted. */
	title?: string;
	description?: string;
	input?: TInput;
};

/**
 * Flat dot-path → `ActionMeta` map describing a peer's full action surface.
 * Returned by the runtime-injected `system.describe` RPC and consumed via
 * `sync.describePeer(deviceId)`.
 */
export type ActionManifest = Record<string, ActionMeta>;

/**
 * A query action definition (read operation).
 *
 * Queries are callable functions with metadata properties attached. They are
 * idempotent operations that read data without side effects. Local callable
 * shape IS the handler's signature (sync stays sync, raw stays raw); remote/
 * AI/CLI consumers see uniform `Promise<Result<T, E | RpcError>>` via the
 * boundary normalizers.
 */
export type Query<
	TInput extends TSchema | undefined = TSchema | undefined,
	R = unknown,
> = ActionHandler<TInput, R> & ActionMeta<TInput> & { type: 'query' };

/**
 * A mutation action definition (write operation).
 *
 * Mutations are callable functions with metadata properties attached. Local
 * callable shape IS the handler's signature; remote/AI/CLI consumers see
 * uniform `Promise<Result<T, E | RpcError>>` via the boundary normalizers.
 */
export type Mutation<
	TInput extends TSchema | undefined = TSchema | undefined,
	R = unknown,
> = ActionHandler<TInput, R> & ActionMeta<TInput> & { type: 'mutation' };

/**
 * Union type of Query and Mutation action definitions.
 */
export type Action<
	TInput extends TSchema | undefined = TSchema | undefined,
	R = unknown,
> = Query<TInput, R> | Mutation<TInput, R>;

/**
 * A tree of action definitions, supporting arbitrary nesting.
 *
 * Uses `any` for the action's input/output/error positions in the constraint
 * so that specific `Query<I, T, E>` / `Mutation<I, T, E>` instances assign
 * cleanly through the variadic-args distribution trick.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Actions = {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	[key: string]: Action<any, any> | Actions;
};

/**
 * The runtime-injected `system.*` action namespace. Single canonical type:
 * `attachSync` constructs `systemActions: SystemActions` (TypeScript checks
 * the construction shape against this) and `peer.ts` derives the proxy type
 * `peer<{ system: SystemActions }>` from the same source. Drift between the
 * runtime handler return and the consumer's expected return becomes a
 * compile error.
 */
export type SystemActions = {
	describe: Query<undefined, ActionManifest>;
};

/**
 * Define a query (read operation) with full type inference.
 *
 * Returns the handler with metadata attached: the action callable IS the
 * handler. Local callers see whatever the handler returns (sync if sync,
 * raw if raw, `Result` if explicit). Remote/AI/CLI consumers see uniform
 * `Promise<Result>` via the boundary normalizers (`peer()` for the wire,
 * `invokeAction` for in-process).
 */
/** No input: `TInput` is explicitly `undefined`. */
export function defineQuery<R>(
	config: ActionConfig<undefined, R>,
): Query<undefined, R>;
/** With input: `TInput` inferred from the schema. */
export function defineQuery<TInput extends TSchema, R>(
	config: ActionConfig<TInput, R>,
): Query<TInput, R>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function defineQuery({ handler, ...rest }: any): Query {
	return Object.assign(handler, {
		type: 'query' as const,
		...rest,
	}) as unknown as Query;
}

/**
 * Define a mutation (write operation) with full type inference.
 *
 * Returns the handler with metadata attached: the action callable IS the
 * handler. Local callers see whatever the handler returns; remote/AI/CLI
 * consumers see uniform `Promise<Result>` via the boundary normalizers.
 */
/** No input: `TInput` is explicitly `undefined`. */
export function defineMutation<R>(
	config: ActionConfig<undefined, R>,
): Mutation<undefined, R>;
/** With input: `TInput` inferred from the schema. */
export function defineMutation<TInput extends TSchema, R>(
	config: ActionConfig<TInput, R>,
): Mutation<TInput, R>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function defineMutation({ handler, ...rest }: any): Mutation {
	return Object.assign(handler, {
		type: 'mutation' as const,
		...rest,
	}) as unknown as Mutation;
}

/**
 * Type guard to check if a value is an action definition.
 *
 * Structural check: anything callable with a `type` of `'query'` or
 * `'mutation'` is an action.
 */
export function isAction(value: unknown): value is Action {
	return (
		typeof value === 'function' &&
		'type' in value &&
		(value.type === 'query' || value.type === 'mutation')
	);
}

/**
 * Type guard to check if a value is a query action definition.
 */
export function isQuery(value: unknown): value is Query {
	return isAction(value) && value.type === 'query';
}

/**
 * Type guard to check if a value is a mutation action definition.
 */
export function isMutation(value: unknown): value is Mutation {
	return isAction(value) && value.type === 'mutation';
}

/**
 * `true` iff `v` is a plain object literal (constructor is `Object` or
 * prototype is `null`). Used to bound `walkActions` so it doesn't recurse
 * into class instances like `Y.Doc`, arktype `Type`, or other workspace
 * furniture: those carry methods on their prototype and have no business
 * being on the wire.
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
	if (typeof v !== 'object' || v === null) return false;
	const proto = Object.getPrototypeOf(v);
	return proto === null || proto === Object.prototype;
}

/**
 * Resolve a dotted path against a workspace (or any object), returning the
 * leaf `Action` if the path lands on one. Returns `undefined` for missing
 * paths or paths that resolve to a namespace.
 *
 * Walks by explicit segment, so passing a full workspace bundle is safe:
 * the resolver only touches the keys named in `path` and never enumerates
 * into class instances.
 */
export function resolveActionPath(
	actions: object,
	path: string,
): Action | undefined {
	const segments = path.split('.');
	let target: unknown = actions;
	for (const segment of segments) {
		if (target == null || typeof target !== 'object') return undefined;
		target = (target as Record<string, unknown>)[segment];
	}
	return isAction(target) ? target : undefined;
}

/**
 * Lazily yield every branded action in a workspace (or any object) as
 * `[dotPath, Action]` pairs. Order is depth-first, left-to-right by author
 * definition (Object key order). Yields live callables: invoke them,
 * inspect them, or strip to metadata via {@link describeActions}.
 *
 * Recursion only descends into plain object literals. Class instances
 * (`Y.Doc`, arktype `Type`, etc.) and functions short-circuit, so passing
 * a full workspace bundle as the root is safe and bounded.
 *
 * Pair with `Object.fromEntries`, `Array.from`, or a `for…of` loop:
 * ```ts
 * for (const [path, action] of walkActions(workspace)) {
 *   if (action.type === 'mutation') console.log(path);
 * }
 * ```
 */
export function* walkActions(
	actions: object,
	prefix = '',
): Generator<[string, Action]> {
	for (const [key, value] of Object.entries(actions)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (isAction(value)) yield [path, value];
		else if (isPlainObject(value)) yield* walkActions(value, path);
	}
}

/**
 * Walk an `Actions` tree into its flat `ActionManifest`: the wire form
 * returned by `system.describe`. Live `input` schemas are retained;
 * functions are dropped. Pairs with `sync.describePeer(id)`, which
 * returns the same shape from a remote peer.
 *
 * Built atop {@link walkActions}. Use that primitive directly if you want
 * to iterate live callables instead of metadata.
 */
export function describeActions(actions: object): ActionManifest {
	return Object.fromEntries(
		Array.from(walkActions(actions), ([path, action]) => [path, toMeta(action)]),
	);
}

function toMeta({ type, input, title, description }: Action): ActionMeta {
	const meta: ActionMeta = { type };
	if (input !== undefined) meta.input = input;
	if (title !== undefined) meta.title = title;
	if (description !== undefined) meta.description = description;
	return meta;
}

/**
 * Invoke an action and normalize its return into a uniform
 * `Promise<Result<T, RpcError>>`.
 *
 * The single canonical normalize: raw values get `Ok`-wrapped, existing
 * `Result`s pass through, and thrown errors become `Err(ActionFailed)`. Used
 * by every consumer that doesn't know the handler shape ahead of time
 * AI tool bridge, CLI dispatch, and the inbound RPC handler.
 *
 * The `errorLabel` (defaulting to `action.title` or `'anonymous'`) appears
 * as `action` on the returned `RpcError.ActionFailed`, so callers see
 * meaningful context in error reports without the util needing the dotted
 * path itself.
 *
 * @example
 * ```ts
 * const result = await invokeAction<{ closedCount: number }>(
 *   workspace.actions.tabs.close,
 *   { tabIds: [1, 2] },
 *   'tabs.close',
 * );
 * if (result.error) { ... }
 * console.log(result.data.closedCount);
 * ```
 */
export async function invokeAction<T = unknown>(
	action: Action,
	input?: unknown,
	errorLabel: string = action.title ?? 'anonymous',
): Promise<Result<T, RpcError>> {
	try {
		const ret =
			action.input !== undefined
				? await (action as (i: unknown) => unknown)(input)
				: await (action as () => unknown)();
		return (isResult(ret) ? ret : Ok(ret)) as Result<T, RpcError>;
	} catch (cause) {
		return RpcError.ActionFailed({ action: errorLabel, cause });
	}
}

// ════════════════════════════════════════════════════════════════════════════
// ACTION FAILED (transport envelope)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Transport-layer error for actions invoked over RPC.
 *
 * Sourced from this package's `RpcError` so the wire and the remote-action
 * type surface share a single nominal `ActionFailed`: no re-wrapping between
 * layers, one `name` discriminant to match on.
 */
export type ActionFailed = Extract<RpcError, { name: 'ActionFailed' }>;

// ════════════════════════════════════════════════════════════════════════════
// REMOTE ACTION TYPES (RPC proxy surface)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Per-remote-call options, threaded through every wrapped leaf as a trailing
 * optional argument. The proxy passes these to `sync.rpc(...)` directly
 * same shape, same name, single source of truth.
 *
 * Currently just `timeout`. Cancellation via `AbortSignal` is deliberately
 * out: the underlying transport doesn't support it (a real cancel requires
 * a CANCEL frame the server understands). Add when plumbed through.
 */
export type RemoteCallOptions = {
	/** Per-call override of the default RPC timeout (ms). Default: 5000. */
	timeout?: number;
};

/**
 * Append an optional `RemoteCallOptions` parameter to an existing arg tuple.
 * No-arg handlers `(): R` become `(input?: undefined, options?: RemoteCallOptions) => ...`
 * so callers can always pass options as the second arg, regardless of whether
 * the action has input.
 */
type WithOptions<Args extends readonly unknown[]> = Args extends []
	? [input?: undefined, options?: RemoteCallOptions]
	: [...Args, options?: RemoteCallOptions];

/**
 * Compute the wrapped shape of a single action callable for remote/normalized
 * consumption. Four flat branches:
 *
 * - `(...) => Promise<Result<T, E>>` → `(...) => Promise<Result<T, E | RpcError>>`
 * - `(...) => Promise<R>`            → `(...) => Promise<Result<R, RpcError>>`
 * - `(...) => Result<T, E>`          → `(...) => Promise<Result<T, E | RpcError>>`
 * - `(...) => R`                     → `(...) => Promise<Result<R, RpcError>>`
 *
 * The data type is unchanged; the error union widens by `RpcError` (to cover
 * transport failures: `ActionFailed`, `Disconnected`, etc.). Every wrapped
 * leaf accepts a trailing `RemoteCallOptions` for per-call overrides.
 */
export type WrapAction<F> = F extends (...args: infer Args) => infer R
	? R extends Promise<infer Inner>
		? Inner extends Result<infer T, infer E>
			? (...args: WithOptions<Args>) => Promise<Result<T, E | RpcError>>
			: (...args: WithOptions<Args>) => Promise<Result<Inner, RpcError>>
		: R extends Result<infer T, infer E>
			? (...args: WithOptions<Args>) => Promise<Result<T, E | RpcError>>
			: (...args: WithOptions<Args>) => Promise<Result<R, RpcError>>
	: never;

/**
 * Mirror an action tree's shape for remote invocation. Each leaf is wrapped
 * via {@link WrapAction} so callers see uniform `Promise<Result<T, E | RpcError>>`
 * regardless of the underlying handler's shape.
 */
export type RemoteActions<A extends Actions> = {
	[K in keyof A]: A[K] extends Action
		? WrapAction<A[K]>
		: A[K] extends Actions
			? RemoteActions<A[K]>
			: never;
};
