/**
 * Hono app for the `epicenter up` daemon. Single source of truth for the
 * routes; the server (`bindUnixSocket`) wires this into Bun's listener
 * and the hand-rolled `daemonClient` in `./client.ts` POSTs against it.
 *
 * Each verb is a one-line shell shortcut for one workspace primitive:
 *
 *   /peers  ->  workspace.sync.peers()
 *   /list   ->  describeActions(workspace.actions)
 *   /run    ->  invokeAction(...) | sync.rpc(...)         (executeRun branches)
 *
 * Each route returns the handler's `Result<T, DomainErr>` body directly.
 * Unexpected exceptions propagate to Hono's default error handler (HTTP
 * 500), which the client maps to `DaemonError.HandlerCrashed`. There is
 * no second on-the-wire envelope: `Result<Result<...>, ...>` is gone.
 */

import { sValidator } from '@hono/standard-validator';
import { describeActions, PeerDevice } from '@epicenter/workspace';
import { type } from 'arktype';
import { Hono } from 'hono';
import { Err, Ok } from 'wellcrafted/result';

import { resolveEntry } from '../util/resolve-entry.js';
import type { WorkspaceEntry } from '../load-config.js';
import { executeRun } from './run-handler.js';
import {
	type ListCtx,
	listCtxSchema,
	peersArgsSchema,
	type RunCtx,
	runCtxSchema,
} from './schemas.js';

/**
 * Row shape returned by `/peers`. One row per `(workspace, clientID)` pair,
 * tagged with its workspace name so a multi-workspace daemon can fan out.
 * `device` carries the canonical `PeerDevice` shape from
 * `@epicenter/workspace`; renderers consume it directly without a cast.
 */
export const PeerSnapshot = type({
	workspace: 'string',
	clientID: 'number',
	device: PeerDevice,
});
export type PeerSnapshot = typeof PeerSnapshot.infer;

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
		.post('/peers', sValidator('json', peersArgsSchema), (c) => {
			const { workspace } = c.req.valid('json');
			const rows: PeerSnapshot[] = [];
			for (const entry of entries) {
				if (workspace && entry.name !== workspace) continue;
				const peers = entry.workspace.sync?.peers() ?? new Map();
				for (const [clientID, state] of peers) {
					rows.push({
						workspace: entry.name,
						clientID,
						device: state.device,
					});
				}
			}
			return c.json(Ok(rows));
		})
		.post('/list', sValidator('json', listCtxSchema), (c) => {
			const ctx = c.req.valid('json') satisfies ListCtx;
			const { data: entry, error } = resolveEntry(entries, ctx.workspace);
			if (error) return c.json(Err(error));
			return c.json(Ok(describeActions(entry.workspace.actions ?? {})));
		})
		.post('/run', sValidator('json', runCtxSchema), async (c) => {
			const ctx = c.req.valid('json') satisfies RunCtx;
			const { data: entry, error } = resolveEntry(entries, ctx.workspace);
			if (error) return c.json(Err(error));
			return c.json(await executeRun(entry, ctx));
		})
		.post('/shutdown', (c) => {
			// Defer past the current event-loop turn so the response is flushed
			// to the kernel before `server.stop()` closes the listening socket.
			setTimeout(triggerShutdown, 0);
			return c.json(Ok(null));
		});
}
