/**
 * Hono app for the `epicenter daemon up` daemon. Single source of truth for the
 * routes; the daemon server wires its fetch handler into Bun's listener and
 * the hand-rolled `daemonClient` in `./client.ts` POSTs against it.
 *
 * Each route is a one-line shell shortcut for one daemon runtime primitive:
 *
 *   /peers  ->  collaboration.devices.list()                       all mounts
 *   /list   ->  flat manifest of `${mount}.${action_key}` -> meta  all mounts
 *   /run    ->  invokeAction(...) locally, or collab.dispatch(...)
 *               on a peer when `peer` is present                   mount-routed
 *
 * Each route returns the handler's `Result<T, DomainErr>` body directly.
 * Unexpected exceptions propagate to Hono's default error handler (HTTP
 * 500), which the client maps to `DaemonError.HandlerCrashed`. There is
 * no second on-the-wire envelope: `Result<Result<...>, ...>` is gone.
 */

import { sValidator } from '@hono/standard-validator';
import { type } from 'arktype';
import { Hono } from 'hono';
import { Ok } from 'wellcrafted/result';
import { type ActionManifest, toActionMeta } from '../shared/actions.js';
import { executeRun } from './action-handler.js';
import { joinDaemonActionPath } from './action-path.js';
import type { DaemonServedMount } from './types.js';

/**
 * Wire body for `/run`. The schema serves two roles:
 *
 *   1. Envelope validation at the daemon boundary via
 *      `@hono/standard-validator`: it checks the request shape (`actionPath`
 *      present, `input` present) so a stale CLI gets a typed 400, NOT the
 *      action's input shape. The input (`unknown` here) is validated against
 *      the resolved action's own schema downstream in `invokeAction`.
 *   2. Compile-time inference for the hand-rolled client; both sides import
 *      the exact same shape.
 *
 * `peer` selects the execution target: absent runs the action on this
 * daemon, present dispatches it to `peer.to`. Grouping the peer fields into
 * one optional object makes the co-occurrence invariant structural: a
 * `waitMs` (peer RPC deadline; the daemon owns its default) cannot exist
 * without a peer target.
 *
 * Naming follows arktype's idiom (one PascalCase name declares both the
 * value and the type).
 */
export const RunRequest = type({
	actionPath: 'string',
	input: 'unknown',
	'peer?': {
		to: 'string',
		'waitMs?': 'number',
	},
});
export type RunRequest = typeof RunRequest.infer;

/**
 * Row shape returned by `/peers`. One row per `(mount, deviceId)` pair,
 * tagged with its mount name so a multi-mount daemon can fan out.
 *
 * `deviceId` is the install-stable, client-claimed identity and the address
 * used by `collab.dispatch({ to })`. There is no per-socket `connectionId`
 * or server-stamped identity on the wire. The relay routes by `deviceId`
 * inside the already authorized sync room.
 */
export const PeerSnapshot = type({
	mount: 'string',
	deviceId: 'string',
});
export type PeerSnapshot = typeof PeerSnapshot.infer;

/**
 * Build the daemon's Hono app. Tests import this directly; production serves
 * the app through the daemon server factory.
 *
 * `/list` exposes mount-prefixed action paths. `/run` uses that same prefix
 * to pick the hosted runtime before executing locally or routing to a peer.
 */
export function buildDaemonApp(mounts: readonly DaemonServedMount[]) {
	return new Hono()
		.post('/ping', (c) => c.json(Ok('pong' as const)))
		.post('/peers', (c) => {
			const rows: PeerSnapshot[] = [];
			for (const entry of mounts) {
				for (const device of entry.runtime.collaboration.devices.list()) {
					rows.push({
						mount: entry.mount,
						deviceId: device.deviceId,
					});
				}
			}
			return c.json(Ok(rows));
		})
		.post('/list', (c) => {
			const manifest: ActionManifest = {};
			for (const entry of mounts) {
				for (const [path, action] of Object.entries(
					entry.runtime.collaboration.actions,
				)) {
					manifest[joinDaemonActionPath(entry.mount, path)] =
						toActionMeta(action);
				}
			}
			return c.json(Ok(manifest));
		})
		.post('/run', sValidator('json', RunRequest), async (c) => {
			const request = c.req.valid('json');
			return c.json(await executeRun(mounts, request));
		});
}
