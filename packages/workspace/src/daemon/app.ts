/**
 * Hono app for the `epicenter up` daemon. Single source of truth for the
 * routes; the server (`bindUnixSocket`) wires this into Bun's listener
 * and the hand-rolled `daemonClient` in `./client.ts` POSTs against it.
 *
 * Each verb is a one-line shell shortcut for one workspace primitive:
 *
 *   /peers  ->  workspace.sync.peers()                       cross-workspace, no body
 *   /list   ->  describeActions(workspace.actions)            single-workspace
 *   /run    ->  invokeAction(...) | sync.rpc(...)             single-workspace
 *
 * Each route returns the handler's `Result<T, DomainErr>` body directly.
 * Unexpected exceptions propagate to Hono's default error handler (HTTP
 * 500), which the client maps to `DaemonError.HandlerCrashed`. There is
 * no second on-the-wire envelope: `Result<Result<...>, ...>` is gone.
 */

import { sValidator } from '@hono/standard-validator';
import { describeActions } from '../shared/actions.js';
import { PeerDevice } from '../document/standard-awareness-defs.js';
import { type } from 'arktype';
import { Hono } from 'hono';
import { Err, Ok } from 'wellcrafted/result';

import { resolveEntry } from './resolve-entry.js';
import type { WorkspaceEntry } from './types.js';
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
 * value and the type). `/peers` takes no body.
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
 * `resolveEntry` returns a `ResolveError` for typo'd or missing `-w`; we
 * fold that into the route's body `Result` so the user sees a clean
 * error, not `DaemonError.HandlerCrashed`.
 */
export function buildApp(entries: WorkspaceEntry[]) {
	return new Hono()
		.post('/ping', (c) => c.json(Ok('pong' as const)))
		.post('/peers', (c) => {
			const rows: PeerSnapshot[] = [];
			for (const entry of entries) {
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
		});
}
