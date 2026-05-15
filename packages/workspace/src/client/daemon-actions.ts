/**
 * `buildDaemonActions`: typed proxy that turns a `DaemonClient` into a flat
 * action-root facade. Local call sites use the same snake_case key the action
 * was authored under (`workspace.tabs_open(...)`); each call dispatches
 * over the unix socket via `client.run`.
 *
 * The proxy is one level: property access returns a function, calling that
 * function fires `client.run` with `${route}.${path}`. `then` is masked at
 * the root so accidental `await workspace` does not turn it thenable.
 */

import type { Result } from 'wellcrafted/result';
import type { DaemonClient, DaemonError } from '../daemon/client.js';
import type { RunError } from '../daemon/run-errors.js';
import type { Action, ActionRegistry } from '../shared/actions.js';
import type { Simplify } from '../shared/types.js';

const DEFAULT_RUN_WAIT_MS = 5_000;

export type DaemonActionOptions = {
	/** Override the daemon `/run` wait budget in milliseconds. */
	waitMs?: number;
};

type WithDaemonOptions<Args extends readonly unknown[]> = Args extends []
	? [input?: undefined, options?: DaemonActionOptions]
	: [...Args, options?: DaemonActionOptions];

type DaemonSuccessOutput<TOutput> =
	Awaited<TOutput> extends Result<infer TData, unknown>
		? TData
		: Awaited<TOutput>;

type WrapDaemonAction<F> = F extends (...args: infer Args) => infer R
	? (
			...args: WithDaemonOptions<Args>
		) => Promise<Result<DaemonSuccessOutput<R>, RunError | DaemonError>>
	: never;

/**
 * The daemon-callable shape of `TActions`. Each registry entry is awaited
 * and `Result`-wrapped at the daemon boundary. One level: keys are the
 * snake_case action keys exactly as the author wrote them.
 *
 * Wrapped in {@link Simplify} so IDE hover output shows the flattened call
 * shape rather than a wall of conditional types.
 */
export type DaemonActions<TActions> = Simplify<{
	[K in keyof TActions & string]: TActions[K] extends Action
		? WrapDaemonAction<TActions[K]>
		: never;
}>;

/**
 * Compose the daemon action facade. Generic `TActions` is the in-process
 * `ActionRegistry`; `DaemonActions<TActions>` rewrites each entry to the
 * daemon `/run` result shape.
 */
export function buildDaemonActions<TActions extends ActionRegistry>(
	client: DaemonClient,
	route: string,
): DaemonActions<TActions> {
	return new Proxy({} as Record<string, unknown>, {
		get(_target, prop) {
			if (typeof prop !== 'string') return undefined;
			if (prop === 'then') return undefined;
			return (input?: unknown, options?: DaemonActionOptions) =>
				client.run({
					actionPath: `${route}.${prop}`,
					input,
					waitMs: options?.waitMs ?? DEFAULT_RUN_WAIT_MS,
				});
		},
	}) as DaemonActions<TActions>;
}
