/**
 * Domain errors for the daemon `/run` route.
 *
 * One union covers both execution targets, because the caller-facing concept
 * is one: run an action, locally or on a peer. The authorities still differ
 * inside the handler: a local run consults this daemon's action registry,
 * while a peer run lets the recipient node decide action existence and the
 * relay own reachability.
 *
 * Remote call failures keep the remote client error intact so the CLI owns
 * every presentation choice for peer disconnects, timeouts, and other
 * wire-level RPC errors.
 *
 * Exit-code mapping (the CLI renderer switches on `name`):
 *
 * - `UsageError`: bad action key, bad input, bad wait budget; exitCode=1.
 * - `RuntimeError`: the local handler returned Err or threw; exitCode=2.
 * - `PeerNotFound`: `--peer <target>` did not resolve within the wait
 *   budget; exitCode=3.
 * - `RemoteCallFailed`: peer resolved but the RPC call itself failed
 *   (timeout, peer disconnected mid-call, wire error); exitCode=2.
 */

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';

import type { DispatchError } from '../document/dispatch.js';
import type {
	SyncError,
	SyncFailedReason,
} from '../document/internal/sync-supervisor.js';

type PeerRemoteError = Exclude<DispatchError, { name: 'RecipientOffline' }>;

export type PeerSyncStatus =
	| { phase: 'offline' }
	| {
			phase: 'connecting';
			retries: number;
			lastErrorType?: SyncError['type'];
	  }
	| { phase: 'connected' }
	| { phase: 'failed'; reason: SyncFailedReason };

export const RunError = defineErrors({
	UsageError: ({
		message,
		suggestions,
	}: {
		message: string;
		suggestions?: string[];
	}) => ({ message, suggestions }),
	RuntimeError: ({ cause }: { cause: unknown }) => ({
		message: extractErrorMessage(cause),
		cause,
	}),
	PeerNotFound: ({
		to,
		waitMs,
		syncStatus,
	}: {
		to: string;
		waitMs: number;
		syncStatus: PeerSyncStatus;
	}) => ({
		message: `no peer matches peer id "${to}"`,
		to,
		waitMs,
		syncStatus,
	}),
	RemoteCallFailed: ({
		cause,
		to,
		syncStatus,
	}: {
		to: string;
		cause: PeerRemoteError;
		syncStatus: PeerSyncStatus;
	}) => ({
		message: `remote call failed: ${cause.name}`,
		cause,
		to,
		syncStatus,
	}),
});
export type RunError = InferErrors<typeof RunError>;
