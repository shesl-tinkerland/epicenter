/**
 * Daemon-side handler for `/run`.
 *
 * One entry point, two execution targets selected by `peer`:
 *
 *   `peer` absent  -> local run: this daemon's action registry decides action
 *                     existence, then `invokeAction` executes the handler.
 *   `peer` present -> peer run: the recipient peer decides action existence,
 *                     and the relay owns reachability.
 *
 * Peer runs address nodes by `nodeId` directly; the relay routes to the
 * most-recently-connected socket for that node. If the relay has no live
 * socket for the target, dispatch resolves with `RecipientOffline`, surfaced
 * here as `PeerNotFound`; any other dispatch error is forwarded under
 * `RemoteCallFailed`.
 *
 * The daemon owns the peer wait budget default ({@link DEFAULT_PEER_WAIT_MS});
 * clients send `waitMs` only when the user overrides it.
 *
 * Power-user automation (loops, fan-out across peers, conditional dispatch)
 * lives in vault-style TypeScript scripts that load the workspace library
 * directly. The CLI deliberately does not grow flags that shadow scripting.
 *
 * Returns a domain response that the route serializes verbatim. Unexpected
 * exceptions bubble to Hono's non-2xx response path and surface as
 * `HandlerCrashed` on the client side.
 */

import { Ok, type Result } from 'wellcrafted/result';
import type { SyncStatus } from '../document/internal/sync-supervisor.js';
import { invokeAction, isActionInputError } from '../shared/actions.js';
import { type PeerSyncStatus, RunError } from './action-errors.js';
import type { RunRequest } from './app.js';
import type { DaemonServedMount } from './types.js';

/** Default peer RPC deadline when the client does not send `waitMs`. */
export const DEFAULT_PEER_WAIT_MS = 5000;

export async function executeRun(
	mountRuntime: DaemonServedMount,
	{ actionPath, input: actionInput, peer }: RunRequest,
): Promise<Result<unknown, RunError>> {
	if (peer === undefined) {
		return runLocal(mountRuntime, actionPath, actionInput);
	}
	const collaboration = mountRuntime.runtime.collaboration;
	if (!collaboration) {
		return RunError.UsageError({
			message: `This daemon does not expose collaboration, so "${actionPath}" cannot run on peer "${peer.to}".`,
		});
	}
	return runOnPeer(collaboration, actionPath, actionInput, peer);
}

/** Local run: this daemon's registry is the authority for action existence. */
async function runLocal(
	mountRuntime: DaemonServedMount,
	actionPath: string,
	actionInput: unknown,
): Promise<Result<unknown, RunError>> {
	const action = mountRuntime.runtime.actions[actionPath];
	if (!action) {
		const descendants = daemonActionSuggestionLines(mountRuntime, actionPath);
		if (descendants.length > 0) {
			return RunError.UsageError({
				message: `"${actionPath}" is not a runnable action.`,
				suggestions: descendants,
			});
		}
		return RunError.UsageError({
			message: `"${actionPath}" is not defined.`,
			suggestions: daemonActionNearestSiblingLines(mountRuntime, actionPath),
		});
	}

	const result = await invokeAction(action, actionInput);
	if (result.error !== null) {
		// Input that fails the action's declared schema is a caller mistake, not
		// a handler crash: surface it as a usage error (the same family as an
		// unknown action) so the CLI exits 1, not 2.
		if (isActionInputError(result.error)) {
			return RunError.UsageError({ message: result.error.message });
		}
		return RunError.RuntimeError({ cause: result.error });
	}
	return Ok(result.data);
}

/** Peer run: the recipient decides action existence, the relay reachability. */
async function runOnPeer(
	collaboration: NonNullable<DaemonServedMount['runtime']['collaboration']>,
	localPath: string,
	actionInput: unknown,
	{ to, waitMs }: NonNullable<RunRequest['peer']>,
): Promise<Result<unknown, RunError>> {
	const budgetMs = waitMs ?? DEFAULT_PEER_WAIT_MS;
	if (!Number.isInteger(budgetMs) || budgetMs < 0) {
		return RunError.UsageError({
			message: '`waitMs` must be a non-negative integer.',
		});
	}

	const result = await collaboration.dispatch({
		to,
		action: localPath,
		input: actionInput,
		signal: AbortSignal.timeout(budgetMs),
	});

	if (result.error !== null) {
		const syncStatus = toPeerSyncStatus(collaboration.status);
		switch (result.error.name) {
			case 'RecipientOffline':
				return RunError.PeerNotFound({
					to,
					waitMs: budgetMs,
					syncStatus,
				});
			case 'ActionNotFound':
			case 'ActionFailed':
			case 'Cancelled':
			case 'NetworkFailed':
				return RunError.RemoteCallFailed({
					cause: result.error,
					to,
					syncStatus,
				});
			default:
				return result.error satisfies never;
		}
	}
	return Ok(result.data);
}

function toPeerSyncStatus(status: SyncStatus): PeerSyncStatus {
	switch (status.phase) {
		case 'offline':
			return { phase: 'offline' };
		case 'connected':
			return { phase: 'connected' };
		case 'connecting':
			return {
				phase: 'connecting',
				retries: status.retries,
				lastErrorType: status.lastError?.type,
			};
		case 'failed':
			return {
				phase: 'failed',
				reason: status.reason,
			};
		default:
			return status satisfies never;
	}
}

function daemonActionSuggestionLines(
	mountRuntime: DaemonServedMount,
	prefix: string,
): string[] {
	return Object.entries(mountRuntime.runtime.actions)
		.filter(([path]) => !prefix || path.startsWith(prefix))
		.map(([path, action]) => `  ${path}  (${action.type})`);
}

function daemonActionNearestSiblingLines(
	mountRuntime: DaemonServedMount,
	missedPath: string,
): string[] {
	const parts = missedPath.split('_');
	while (parts.length > 0) {
		parts.pop();
		const prefix = parts.join('_');
		const alts = daemonActionSuggestionLines(mountRuntime, prefix);
		if (alts.length > 0) return alts;
	}
	return [];
}
