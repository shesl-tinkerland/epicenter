/**
 * Hono app for the `epicenter up` daemon. Single source of truth for the
 * routes; the server (`bindUnixSocket`) wires this into Bun's listener
 * and the hand-rolled `daemonClient` in `./client.ts` POSTs against it.
 *
 * Each verb is a one-line shell shortcut for one workspace primitive:
 *
 *   /list   ->  describeActions(workspace.actions)            single-workspace
 *   /run    ->  invokeAction(...) | sync.rpc(...)             single-workspace
 *
 * Each route returns the handler's `Result<T, DomainErr>` body directly.
 * Unexpected exceptions propagate to Hono's default error handler (HTTP
 * 500), which the client maps to `DaemonError.HandlerCrashed`. There is
 * no second on-the-wire envelope: `Result<Result<...>, ...>` is gone.
 */

import { sValidator } from '@hono/standard-validator';
import { describeActions } from '@epicenter/workspace';
import { type } from 'arktype';
import { Hono } from 'hono';
import { Err, Ok } from 'wellcrafted/result';

import { resolveEntry } from '../util/resolve-entry.js';
import type { WorkspaceEntry } from '../load-config.js';
import { executeRun } from './run-handler.js';

/**
 * Wire bodies for `/list` and `/run`. Schemas serve two roles:
 *
 *   1. Runtime validation at the daemon boundary via
 *      `@hono/standard-validator`. A stale CLI gets a typed 400 instead of a
 *      downstream cast failure.
 *   2. Compile-time inference for the hand-rolled client; both sides import
 *      the exact same shape.
 *
 * Naming follows arktype's idiom (one PascalCase name declares both the
 * value and the type). `/peers` and `/shutdown` take no body.
 */

export const ListInput = type({
	'workspace?': 'string',
});
export type ListInput = typeof ListInput.infer;

export const RunInput = type({
	actionPath: 'string',
	input: 'unknown',
	'peerTarget?': 'string',
	waitMs: 'number',
	'workspace?': 'string',
});
export type RunInput = typeof RunInput.infer;

/**
 * Build the daemon's Hono app. Tests import this directly; production wires
 * it into `Bun.serve({ unix, fetch: app.fetch })` via `bindUnixSocket`.
 *
 * `triggerShutdown` is invoked from the `/shutdown` route after the response
 * is queued. We use `setTimeout(.., 0)` rather than `queueMicrotask` so the
 * response bytes hit the wire before the server begins teardown.
 *
 * `resolveEntry` returns a `ResolveError` for typo'd or missing `-w`; we
 * fold that into the route's body `Result` so the user sees a clean
 * error, not `DaemonError.HandlerCrashed`.
 */
export function buildApp(
	entries: WorkspaceEntry[],
	triggerShutdown: () => void,
) {
	return new Hono()
		.post('/ping', (c) => c.json(Ok('pong' as const)))
		.post('/list', sValidator('json', ListInput), (c) => {
			const input = c.req.valid('json');
			const { data: entry, error } = resolveEntry(entries, input.workspace);
			if (error) return c.json(Err(error));
			return c.json(Ok(describeActions(entry.workspace.actions ?? {})));
		})
		.post('/run', sValidator('json', RunInput), async (c) => {
			const input = c.req.valid('json');
			const { data: entry, error } = resolveEntry(entries, input.workspace);
			if (error) return c.json(Err(error));
			return c.json(await executeRun(entry, input));
		})
		.post('/shutdown', (c) => {
			// Defer past the current event-loop turn so the response is flushed
			// to the kernel before `server.stop()` closes the listening socket.
			setTimeout(triggerShutdown, 0);
			return c.json(Ok(null));
		});
}
