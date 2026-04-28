/**
 * `epicenter run <dot.path> [input]`: invoke a `defineQuery` /
 * `defineMutation` by dot-path through the local `epicenter serve` server.
 *
 * `input` is JSON: inline positional, `@file.json` (curl convention), or stdin.
 * With `--peer <target>`, the invocation is dispatched over the sync
 * room's RPC channel to a remote peer instead of running locally.
 *
 * `epicenter run` requires a running server for the resolved `--dir`.
 * Without `serve`, the handler errors with a hint pointing at `epicenter serve`.
 *
 * Exit codes:
 *   1: usage error (unknown action, missing sync for `--peer`),
 *      workspace miss (`UnknownWorkspace`, `AmbiguousWorkspace`),
 *      or no daemon / config (`MissingConfig`, `Required`, transport error)
 *   2: runtime error (local action returned Err, or remote RPC failed)
 *   3: peer-miss (`--peer <target>` didn't resolve within `--wait`)
 */

import type { PeerMiss, RpcError } from '@epicenter/workspace';
import pc from 'picocolors';
import { extractErrorMessage } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { Argv, CommandModule, Options } from 'yargs';

import type { RunInput } from '../daemon/app';
import { type DaemonError, getDaemon } from '../daemon/client';
import type { RunError } from '../daemon/run-errors';
import type { AwarenessState } from '../load-config';
import type { ResolveError } from '../daemon/resolve-entry';
import {
	dirOption,
	resolveTarget,
	workspaceOption,
} from '../util/common-options';
import {
	fail,
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
			fail(daemonErr.message);
			return;
		}
		const result = await daemon.run(ctx);
		render(result, { format, workspace: target.userWorkspace });
	},
};

type RunResult = Result<
	unknown,
	RunError | PeerMiss | ResolveError | DaemonError
>;
type RenderContext = {
	format: 'json' | 'jsonl' | undefined;
	/** The user-typed `-w` flag value, known only to the CLI; scopes "look here next" hints. */
	workspace: string | undefined;
};
type ErrorName = NonNullable<RunResult['error']>['name'];

/**
 * Exit code for every error variant that can flow through `epicenter run`.
 * `satisfies` makes drift a compile error: adding a new variant to any of
 * the upstream error unions (workspace, daemon, CLI) breaks the build
 * until an exit code is assigned here.
 *
 * - 1: usage / config / transport errors
 * - 2: runtime failure (action threw, RPC failed)
 * - 3: peer miss (`--peer` target didn't resolve within `--wait`)
 */
const EXIT_CODE = {
	UsageError: 1,
	RuntimeError: 2,
	PeerMiss: 3,
	RpcError: 2,
	UnknownWorkspace: 1,
	AmbiguousWorkspace: 1,
	MissingConfig: 1,
	Required: 1,
	Timeout: 1,
	Unreachable: 1,
	HandlerCrashed: 1,
} as const satisfies Record<ErrorName, 1 | 2 | 3>;

function render(result: RunResult, ctx: RenderContext): void {
	if (result.error === null) {
		output(result.data, { format: ctx.format });
		return;
	}
	for (const line of formatError(result.error, ctx)) outputError(line);
	process.exitCode = EXIT_CODE[result.error.name];
}

export function formatError(
	error: NonNullable<RunResult['error']>,
	ctx: RenderContext,
): string[] {
	switch (error.name) {
		case 'UsageError': {
			const lines = [error.message];
			if (error.suggestions && error.suggestions.length > 0) {
				lines.push('', 'Exposed actions at this path:', ...error.suggestions);
			}
			return lines;
		}
		case 'RuntimeError':
			return [error.message];
		case 'PeerMiss':
			return formatPeerMiss(error, ctx.workspace);
		case 'RpcError':
			return formatRpcError(error.cause, error.targetClientId, error.peerState);
		default:
			return [`${ERR} ${error.message}`];
	}
}

const ERR = pc.red('error:');

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
 * (user typo / wrong workspace). `workspace` is the user-typed `-w` flag,
 * known only to the CLI; it scopes the "look here next" hint.
 */
export function formatPeerMiss(
	error: PeerMiss,
	workspace: string | undefined,
): string[] {
	const { peerTarget, sawPeers, waitMs, emptyReason } = error;
	const lines: string[] = [];
	if (!sawPeers) {
		lines.push(
			`${ERR} no peers seen after waiting ${waitMs}ms for "${peerTarget}"`,
		);
	} else {
		const scope = workspace ? ` in workspace ${workspace}` : '';
		lines.push(`${ERR} no peer matches deviceId "${peerTarget}"${scope}`);
		const peersHint = workspace ? ` -w ${workspace}` : '';
		lines.push(`run \`epicenter peers${peersHint}\` to see connected peers`);
	}
	if (emptyReason) lines.push(`  reason: ${emptyReason}`);
	return lines;
}

/**
 * Format every `RpcError` variant labeled with the peer's presence info
 * (`device.name`, `device.platform`) at resolution time. The exhaustive
 * switch is enforced at compile time via the `never` check: adding a new
 * variant to `@epicenter/workspace`'s `RpcError` breaks the build until a
 * case is added here.
 */
export function formatRpcError(
	error: RpcError,
	targetClientId: number,
	peerState: AwarenessState,
): string[] {
	const { device } = peerState;
	const peerLabel = `${device.name} (${targetClientId}, ${device.platform})`;

	switch (error.name) {
		case 'ActionNotFound':
			return [`${ERR} ActionNotFound "${error.action}" on ${peerLabel}`];
		case 'Timeout':
			return [`${ERR} timeout after ${error.ms}ms on ${peerLabel}`];
		case 'PeerOffline':
			return [`${ERR} peer ${peerLabel} is offline`];
		case 'PeerNotFound':
			return [`${ERR} no peer with deviceId "${error.peer}"`];
		case 'PeerLeft':
			return [`${ERR} peer "${error.peer}" disconnected before responding`];
		case 'ActionFailed':
			return [
				`${ERR} "${error.action}" failed on ${peerLabel}: ${extractErrorMessage(error.cause)}`,
			];
		case 'Disconnected':
			return [`${ERR} connection lost before ${peerLabel} responded`];
		default:
			error satisfies never;
			return [];
	}
}
