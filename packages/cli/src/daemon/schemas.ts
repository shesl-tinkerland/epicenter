/**
 * Arktype schemas for the wire bodies of `epicenter up`'s IPC routes.
 *
 * Two purposes:
 *
 * 1. **Runtime validation at the daemon boundary** via
 *    `@hono/standard-validator`. A stale CLI calling a current daemon (or
 *    vice versa) gets a typed 400 instead of a confusing downstream cast
 *    failure.
 * 2. **Compile-time inference for the hand-rolled client.** Each route's
 *    input type is derived from its validator and imported by the client,
 *    so call sites are checked against the same shape the daemon expects.
 *
 * Naming follows arktype's idiom (mirrored by `PeerSnapshot` in `app.ts`):
 * one PascalCase name per schema, declaring both the value and the type.
 *
 * The schemas reflect the "CLI shortcut == one workspace primitive" model:
 *
 *   /list   ->  describeActions(workspace.actions)             local only
 *   /peers  ->  workspace.sync.peers()                         no body, cross-workspace
 *   /run    ->  invokeAction (local) or sync.rpc (remote, via peerTarget)
 */

import { type } from 'arktype';

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
