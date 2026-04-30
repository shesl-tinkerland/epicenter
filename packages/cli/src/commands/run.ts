/**
 * `epicenter run <dot.path> [input]`: invoke a `defineQuery` /
 * `defineMutation` by dot-path through the local `epicenter up` daemon.
 *
 * `input` is JSON: inline positional, `@file.json` (curl convention), or stdin.
 * With `--peer <target>`, the invocation is dispatched over the selected
 * export's RPC channel to a remote peer instead of running locally.
 *
 * `epicenter run` requires a running daemon for the discovered project.
 * Without `up`, the handler errors with a hint pointing at `epicenter up`.
 *
 * Exit codes:
 *   1: usage error (unknown export, unknown action, missing peer RPC for
 *      `--peer`), or no daemon / config (`MissingConfig`, `Required`,
 *      transport error)
 *   2: runtime error (local action returned Err, or remote RPC failed)
 *   3: peer-miss (`--peer <target>` didn't resolve within `--wait`)
 */

import {
	type PeerAwarenessState,
	type RpcError,
} from '@epicenter/workspace';
import {
	type DaemonError,
	getDaemon,
	type RunError as DaemonRunError,
	type RunRequest,
} from '@epicenter/workspace/node';
import { defineCommand } from 'citty';
import { extractErrorMessage } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

import { projectArg, resolveProjectArg } from '../util/common-options.js';
import {
	formatArgs,
	type OutputFormat,
	output,
	outputError,
} from '../util/format-output.js';
import { parseJsonInput, readStdin } from '../util/parse-input.js';

const DEFAULT_PEER_WAIT_MS = 5000;

export const runCommand = defineCommand({
	meta: {
		name: 'run',
		description:
			'Invoke a defineQuery / defineMutation by dot-path, locally or on a remote peer (--peer)',
	},
	args: {
		action: {
			type: 'positional',
			description: 'Export-prefixed action path, e.g. notes.notes.add',
			required: true,
		},
		input: {
			type: 'positional',
			description: 'Inline JSON or @file.json',
			required: false,
		},
		project: projectArg,
		peer: {
			type: 'string',
			description: 'Invoke on a remote peer by peer id',
			valueHint: 'peer',
		},
		wait: {
			type: 'string',
			description: `Total ms to wait for peer resolution and RPC; requires --peer (default ${DEFAULT_PEER_WAIT_MS})`,
			valueHint: 'ms',
		},
		...formatArgs,
	},
	run: async ({ args }) => {
		const peerTarget =
			args.peer && args.peer.length > 0 ? args.peer : undefined;
		const waitMs = parseWaitArg(args.wait, peerTarget);
		const actionInput = await resolveInput(args.input);

		const runRequest: RunRequest = {
			actionPath: args.action,
			input: actionInput,
			peerTarget,
			waitMs,
		};

		const { data: daemon, error: daemonErr } = await getDaemon(
			resolveProjectArg(args.project),
		);
		if (daemonErr) {
			outputError(daemonErr.message);
			process.exitCode = 1;
			return;
		}
		const result = await daemon.run(runRequest);
		renderRunResult(result, args.format);
	},
});

function parseWaitArg(
	wait: string | undefined,
	peerTarget: string | undefined,
): number {
	if (wait === undefined) return DEFAULT_PEER_WAIT_MS;
	if (peerTarget === undefined) {
		throw new Error('--wait requires --peer');
	}
	const waitMs = Number(wait);
	if (!Number.isFinite(waitMs) || waitMs < 0) {
		throw new Error('--wait must be a non-negative number of milliseconds');
	}
	return waitMs;
}

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
		case 'PeerMiss': {
			emitMissError(
				result.error.peerTarget,
				result.error.sawPeers,
				result.error.waitMs,
			);
			if (result.error.emptyReason)
				outputError(`  reason: ${result.error.emptyReason}`);
			process.exitCode = 3;
			return;
		}
		case 'RpcError':
			emitRpcError(
				result.error.cause,
				result.error.targetClientId,
				result.error.peerState,
			);
			process.exitCode = 2;
			return;
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
export function emitMissError(
	target: string,
	sawPeers: boolean,
	waitMs: number,
): void {
	if (!sawPeers) {
		outputError(
			`error: no peers seen after waiting ${waitMs}ms for "${target}"`,
		);
		return;
	}
	outputError(`error: no peer matches peer id "${target}"`);
	outputError('run `epicenter peers` to see connected peers');
}

/**
 * Format every `RpcError` variant labeled with the peer's presence info
 * (`peer.name`, `peer.platform`) at resolution time. The exhaustive
 * switch is enforced at compile time via the `never` check: adding a new
 * variant to `@epicenter/workspace`'s `RpcError` breaks the build until a
 * case is added here.
 */
export function emitRpcError(
	error: RpcError,
	targetClientId: number,
	peerState: PeerAwarenessState,
): void {
	const { peer } = peerState;
	const peerLabel = `${peer.name} (${targetClientId}, ${peer.platform})`;

	switch (error.name) {
		case 'ActionNotFound':
			outputError(`error: ActionNotFound "${error.action}" on ${peerLabel}`);
			return;
		case 'Timeout':
			outputError(`error: timeout after ${error.ms}ms on ${peerLabel}`);
			return;
		case 'PeerOffline':
			outputError(`error: peer ${peerLabel} is offline`);
			return;
		case 'PeerNotFound':
			outputError(`error: no peer with peer id "${error.peer}"`);
			return;
		case 'PeerLeft':
			outputError(`error: peer "${error.peer}" disconnected before responding`);
			return;
		case 'ActionFailed':
			outputError(
				`error: "${error.action}" failed on ${peerLabel}: ${extractErrorMessage(error.cause)}`,
			);
			return;
		case 'Disconnected':
			outputError(`error: connection lost before ${peerLabel} responded`);
			return;
		default:
			error satisfies never;
	}
}
