/**
 * `epicenter run <dot.path> [input]`: invoke a `defineQuery` /
 * `defineMutation` by dot-path through the local `epicenter up` daemon.
 *
 * `input` is JSON: inline positional, `@file.json` (curl convention), or stdin.
 * With `--peer <target>`, the invocation is dispatched over the selected
 * route's RPC channel to a remote peer instead of running locally.
 *
 * `epicenter run` requires a running daemon for the discovered project.
 * Without `up`, the handler errors with a hint pointing at `epicenter up`.
 *
 * Exit codes:
 *   1: usage error (unknown route, unknown action, invalid input for
 *      `--peer`), or no daemon / config (`MissingConfig`, `Required`,
 *      transport error)
 *   2: runtime error (local action returned Err, or remote RPC failed)
 *   3: peer not found (`--peer <target>` did not resolve within `--wait`)
 */

import {
	type PeerAwarenessState,
	type RemoteCallError,
	type RpcError,
} from '@epicenter/workspace';
import {
	type DaemonError,
	getDaemon,
	type RunError as DaemonRunError,
	type RunRequest,
	type RunSyncStatus,
} from '@epicenter/workspace/node';
import { extractErrorMessage } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

import { cmd } from '../util/cmd.js';
import { projectOption } from '../util/common-options.js';
import {
	formatOptions,
	type OutputFormat,
	output,
	outputError,
} from '../util/format-output.js';
import { parseJsonInput, readStdin } from '../util/parse-input.js';

const DEFAULT_PEER_WAIT_MS = 5000;

export const runCommand = cmd({
	command: 'run <action> [input]',
	describe:
		'Invoke a defineQuery / defineMutation by dot-path, locally or on a remote peer (--peer)',
	builder: (yargs) =>
		yargs
			.positional('action', {
				type: 'string',
				demandOption: true,
				describe: 'Route-prefixed action path, e.g. notes.notes.add',
			})
			.positional('input', {
				type: 'string',
				describe: 'Inline JSON or @file.json',
			})
			.option('C', projectOption)
			.option('peer', {
				type: 'string',
				description: 'Invoke on a remote peer by peer id',
			})
			.option('wait', {
				type: 'number',
				description: `Total ms to wait for peer resolution + RPC; requires --peer (default ${DEFAULT_PEER_WAIT_MS})`,
			})
			.implies('wait', 'peer')
			.options(formatOptions)
			.strict(),
	handler: async (argv) => {
		const peerTarget =
			argv.peer && argv.peer.length > 0 ? argv.peer : undefined;
		const waitMs = argv.wait ?? DEFAULT_PEER_WAIT_MS;
		const actionInput = await resolveInput(argv.input);

		const runRequest: RunRequest = {
			actionPath: argv.action,
			input: actionInput,
			peerTarget,
			waitMs,
		};

		const { data: daemon, error: daemonErr } = await getDaemon(argv.C);
		if (daemonErr) {
			outputError(daemonErr.message);
			process.exitCode = 1;
			return;
		}
		const result = await daemon.run(runRequest);
		renderRunResult(result, argv.format);
	},
});

function renderRunResult(
	result: Result<unknown, DaemonRunError | DaemonError>,
	format: OutputFormat | undefined,
): void {
	if (result.error === null) {
		output(result.data, { format });
		return;
	}
	switch (result.error.name) {
		case 'UsageError': {
			outputError(result.error.message);
			if (result.error.suggestions && result.error.suggestions.length > 0) {
				outputError('');
				outputError('Exposed actions at this path:');
				for (const line of result.error.suggestions) outputError(line);
			}
			process.exitCode = 1;
			return;
		}
		case 'RuntimeError':
			outputError(result.error.message);
			process.exitCode = 2;
			return;
		case 'RemoteCallFailed': {
			emitRemoteCallError(
				result.error.peerTarget,
				result.error.cause,
				result.error.syncStatus,
			);
			process.exitCode = result.error.cause.name === 'PeerNotFound' ? 3 : 2;
			return;
		}
		case 'MissingConfig':
		case 'Required':
		case 'Timeout':
		case 'Unreachable':
		case 'HandlerCrashed':
			outputError(`error: ${result.error.message}`);
			process.exitCode = 1;
			return;
	}
}

async function resolveInput(input: string | undefined): Promise<unknown> {
	const positional = input && input.length > 0 ? input : undefined;
	const stdinContent = await readStdin();
	return parseJsonInput({ positional, stdinContent });
}

/**
 * Two miss shapes: nothing seen on the wire (probably a connect-status
 * problem) vs peers visible but none matched the requested peer id.
 */
function emitMissError(
	target: string,
	sawPeers: boolean,
	waitMs: number,
	syncStatus: RunSyncStatus,
): void {
	if (!sawPeers) {
		outputError(
			`error: no peers seen after waiting ${waitMs}ms for "${target}"`,
		);
		outputError(`  reason: ${describePeerMissReason(syncStatus)}`);
		return;
	}
	outputError(`error: no peer matches peer id "${target}"`);
	outputError(`  reason: ${describePeerMissReason(syncStatus)}`);
	outputError('run `epicenter peers` to see connected peers');
}

export function emitRemoteCallError(
	peerTarget: string,
	cause: RemoteCallError,
	syncStatus: RunSyncStatus,
): void {
	switch (cause.name) {
		case 'PeerNotFound':
			emitMissError(cause.peerTarget, cause.sawPeers, cause.waitMs, syncStatus);
			return;
		case 'PeerLeft':
			emitPeerLeftError(cause.peerTarget, cause.targetClientId, cause.peerState);
			return;
		case 'ActionNotFound':
		case 'Timeout':
		case 'PeerOffline':
		case 'ActionFailed':
		case 'Disconnected':
			emitRpcError(cause, peerTarget);
			return;
		default:
			cause satisfies never;
	}
}

function describePeerMissReason(status: RunSyncStatus): string {
	if (status.phase === 'connected') {
		return 'connected, but no matching peer was visible';
	}
	if (status.phase === 'connecting' && status.lastErrorType) {
		const retries = status.retries;
		const word = retries === 1 ? 'retry' : 'retries';
		return `not connected (${status.lastErrorType} error after ${retries} ${word})`;
	}
	if (status.phase === 'failed') {
		return `not connected (${status.reason.type} ${status.reason.code})`;
	}
	return 'not connected';
}

/**
 * Format every `RpcError` variant labeled with the peer's presence info
 * (`peer.name`, `peer.platform`) at resolution time. The exhaustive
 * switch is enforced at compile time via the `never` check: adding a new
 * variant to `@epicenter/workspace`'s `RpcError` breaks the build until a
 * case is added here.
 */
function emitRpcError(error: RpcError, peerTarget: string): void {
	switch (error.name) {
		case 'ActionNotFound':
			outputError(`error: ActionNotFound "${error.action}" on ${peerTarget}`);
			return;
		case 'Timeout':
			outputError(`error: timeout after ${error.ms}ms on ${peerTarget}`);
			return;
		case 'PeerOffline':
			outputError(`error: peer ${peerTarget} is offline`);
			return;
		case 'ActionFailed':
			outputError(
				`error: "${error.action}" failed on ${peerTarget}: ${extractErrorMessage(error.cause)}`,
			);
			return;
		case 'Disconnected':
			outputError(`error: connection lost before ${peerTarget} responded`);
			return;
		default:
			error satisfies never;
	}
}

function emitPeerLeftError(
	peerTarget: string,
	targetClientId: number,
	peerState: PeerAwarenessState,
): void {
	const { peer } = peerState;
	const peerLabel = `${peer.name} (${targetClientId}, ${peer.platform})`;
	outputError(`error: peer "${peerTarget}" disconnected before responding`);
	outputError(`  last seen as ${peerLabel}`);
}
