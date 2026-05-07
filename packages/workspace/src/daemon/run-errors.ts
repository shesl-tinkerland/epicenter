/**
 * Domain errors and response envelope for the `/run` route.
 *
 * Lives daemon-side because the route owns the wire contract: `executeRun`
 * constructs `RunError` variants in `run-handler.ts`, and the response
 * envelope (`RunResponse`) is what the route serializes to JSON. The CLI
 * command imports both for renderer typing.
 *
 * Remote call failures keep the remote client error intact so the CLI owns
 * every presentation choice for peer misses, peer disconnects, and RPC errors.
 */

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

import type { SyncError, SyncFailedReason } from '../document/attach-sync.js';
import type { RemoteCallError } from '../rpc/remote-actions.js';

export type RunSyncStatus =
	| { phase: 'offline' }
	| {
			phase: 'connecting';
			retries: number;
			lastErrorType?: SyncError['type'];
	  }
	| { phase: 'connected' }
	| { phase: 'failed'; reason: SyncFailedReason };

/**
 * CLI-specific failures of the `/run` route. Carrying the failure mode
 * in-band lets the renderer set `process.exitCode` from a single switch,
 * even when the result arrived over IPC.
 *
 * - `UsageError`: bad action path / missing sync; renderer exitCode=1.
 * - `RuntimeError`: action returned Err locally; renderer exitCode=2.
 * - `RemoteCallFailed`: `--peer <target>` failed in remote client dispatch;
 *   renderer maps `PeerNotFound` to exitCode=3 and other causes to exitCode=2.
 */
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
	RemoteCallFailed: ({
		cause,
		peerTarget,
		syncStatus,
	}: {
		peerTarget: string;
		cause: RemoteCallError;
		syncStatus: RunSyncStatus;
	}) => ({
		message: `remote call failed: ${cause.name}`,
		cause,
		peerTarget,
		syncStatus,
	}),
});
export type RunError = InferErrors<typeof RunError>;

/**
 * Wire shape of `/run`'s response body. The renderer narrows on
 * `error.name`.
 */
export type RunResponse = Result<unknown, RunError>;
