/**
 * `epicenter run <dot.path> [input]`: invoke a `defineQuery` /
 * `defineMutation` by dot-path through the local `epicenter up` daemon.
 *
 * `input` is JSON: inline positional, `@file.json` (curl convention), or stdin.
 * With `--peer <target>`, the invocation is dispatched over the sync
 * room's RPC channel to a remote peer instead of running locally.
 *
 * `epicenter run` requires a running daemon for the resolved `--dir`.
 * Without `up`, the handler errors with a hint pointing at `epicenter up`.
 *
 * Exit codes:
 *   1: usage error (unknown action, missing sync for `--peer`),
 *      workspace miss (`UnknownWorkspace`, `AmbiguousWorkspace`),
 *      or no daemon / config (`MissingConfig`, `Required`, transport error)
 *   2: runtime error (local action returned Err, or remote RPC failed)
 *   3: peer-miss (`--peer <target>` didn't resolve within `--wait`)
 */

import type { RpcError } from '@epicenter/workspace';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { Argv, CommandModule, Options } from 'yargs';

import type { RunInput } from '../daemon/app';
import { type DaemonError, getDaemon } from '../daemon/client';
import type { AwarenessState } from '../load-config';
import type { ResolveError } from '../util/resolve-entry';
import {
	dirOption,
	resolveTarget,
	workspaceOption,
} from '../util/common-options';
import {
	formatYargsOptions,
	output,
	outputError,
} from '../util/format-output';
import { parseJsonInput, readStdin } from '../util/parse-input';

const DEFAULT_PEER_WAIT_MS = 5000;

const peerOption: Options = {
	type: 'string',
	description: 'Invoke on a remote peer by deviceId',
};

const waitOption: Options = {
	type: 'number',
	default: DEFAULT_PEER_WAIT_MS,
	description: 'Total ms to wait for peer resolution + RPC; requires --peer.',
};

/**
 * Domain errors returned by the `/run` route. Carrying the failure mode
 * in-band lets the renderer set `process.exitCode` from a single switch,
 * even when the result arrived over IPC.
 *
 * - `UsageError`: bad action path / missing sync; renderer exitCode=1.
 * - `RuntimeError`: action returned Err locally; renderer exitCode=2.
 * - `PeerMiss`: `--peer` target didn't resolve within `waitMs`; exitCode=3.
 * - `RpcError`: remote RPC returned an `RpcError`; exitCode=2.
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
	PeerMiss: ({
		peerTarget,
		sawPeers,
		workspace,
		waitMs,
		emptyReason,
	}: {
		peerTarget: string;
		sawPeers: boolean;
		workspace?: string;
		waitMs: number;
		emptyReason: string | null;
	}) => ({
		message: `no peer matches deviceId "${peerTarget}"`,
		peerTarget,
		sawPeers,
		workspace,
		waitMs,
		emptyReason,
	}),
	RpcError: ({
		cause,
		targetClientId,
		peerState,
	}: {
		cause: RpcError;
		targetClientId: number;
		peerState: AwarenessState;
	}) => ({
		message: `RPC failed: ${cause.name}`,
		cause,
		targetClientId,
		peerState,
	}),
});
export type RunError = InferErrors<typeof RunError>;

/**
 * Wire shape of `/run`'s response body. Wider than `executeRun`'s actual
 * return type because the route prepends `ResolveError` for `-w` misses
 * before dispatching. The renderer narrows on `error.name`.
 */
export type RunResponse = Result<unknown, RunError | ResolveError>;

export const runCommand: CommandModule = {
	command: 'run <action> [input]',
	describe:
		'Invoke a defineQuery / defineMutation by dot-path, locally or on a remote peer (--peer)',
	builder: (yargs: Argv) =>
		yargs
			.positional('action', {
				type: 'string',
				describe: 'Action path, e.g. savedTabs.create',
			})
			.positional('input', {
				type: 'string',
				describe: 'Inline JSON, @file.json, or omit to read stdin',
			})
			.option('dir', dirOption)
			.option('workspace', workspaceOption)
			.option('peer', peerOption)
			.option('wait', waitOption)
			.implies('wait', 'peer')
			.options(formatYargsOptions())
			.example('$0 run sync.status', 'Invoke a query with no input')
			.example(
				'$0 run savedTabs.create \'{"url":"https://...","title":"..."}\'',
				'Inline JSON input',
			)
			.example(
				'$0 run savedTabs.create @tab.json',
				'Read JSON input from a file',
			)
			.example(
				'echo \'{"id":"abc"}\' | $0 run savedTabs.remove',
				'Pipe JSON input on stdin',
			)
			.example(
				'$0 run sync.status --peer device-mac',
				'Dispatch to a remote peer over the sync room',
			),
	handler: async (argv) => {
		const args = argv as Record<string, unknown>;
		const actionPath = String(args.action);
		const format = args.format as 'json' | 'jsonl' | undefined;
		const peerTarget =
			typeof args.peer === 'string' && args.peer.length > 0
				? args.peer
				: undefined;
		const waitMs = args.wait as number;
		const target = resolveTarget(args);
		const input = await resolveInput(args);

		const ctx: RunInput = {
			actionPath,
			input,
			peerTarget,
			waitMs,
			workspace: target.userWorkspace,
		};

		const { data: daemon, error: daemonErr } = await getDaemon(target);
		if (daemonErr) {
			outputError(daemonErr.message);
			process.exitCode = 1;
			return;
		}
		const result = await daemon.run(ctx);
		renderRunResult(result, format);
	},
};

function renderRunResult(
	result: Result<unknown, RunError | ResolveError | DaemonError>,
	format: 'json' | 'jsonl' | undefined,
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
				result.error.workspace,
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
		case 'UnknownWorkspace':
		case 'AmbiguousWorkspace':
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

async function resolveInput(argv: Record<string, unknown>): Promise<unknown> {
	const positional =
		typeof argv.input === 'string' && argv.input.length > 0
			? (argv.input as string)
			: undefined;
	const stdinContent = await readStdin();
	return parseJsonInput({ positional, stdinContent });
}

/**
 * Two miss shapes: nothing seen on the wire (probably a connect-status
 * problem) vs peers visible but none matched the requested deviceId
 * (user typo / wrong workspace).
 */
export function emitMissError(
	target: string,
	sawPeers: boolean,
	workspace: string | undefined,
	waitMs: number,
): void {
	const scope = workspace ? ` in workspace ${workspace}` : '';
	if (!sawPeers) {
		outputError(
			`error: no peers seen after waiting ${waitMs}ms for "${target}"`,
		);
		return;
	}
	outputError(`error: no peer matches deviceId "${target}"${scope}`);
	const peersHint = workspace ? ` -w ${workspace}` : '';
	outputError(`run \`epicenter peers${peersHint}\` to see connected peers`);
}

/**
 * Format every `RpcError` variant labeled with the peer's presence info
 * (`device.name`, `device.platform`) at resolution time. The exhaustive
 * switch is enforced at compile time via the `never` check: adding a new
 * variant to `@epicenter/workspace`'s `RpcError` breaks the build until a
 * case is added here.
 */
export function emitRpcError(
	error: RpcError,
	targetClientId: number,
	peerState: AwarenessState,
): void {
	const { device } = peerState;
	const peerLabel = `${device.name} (${targetClientId}, ${device.platform})`;

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
			outputError(`error: no peer with deviceId "${error.peer}"`);
			return;
		case 'PeerLeft':
			outputError(
				`error: peer "${error.peer}" disconnected before responding`,
			);
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
