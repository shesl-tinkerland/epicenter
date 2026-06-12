/**
 * `epicenter run <mount.action_key> [input]`: invoke a `defineQuery` or
 * `defineMutation` by mount-prefixed action path through the local
 * `epicenter daemon up` daemon.
 *
 * `input` is JSON: inline positional, `@file.json` (curl convention), or stdin.
 * With `--peer <target>`, the daemon dispatches the run over the selected
 * mount's RPC channel to a remote peer instead of running locally; both
 * shapes are one `/run` request (the optional `peer` object selects the
 * target and carries the wait budget).
 *
 * `epicenter run` requires a running daemon for the discovered project.
 * Without `daemon up`, the handler errors with a hint pointing at
 * `epicenter daemon up`.
 *
 * Exit codes:
 *   1: usage error (unknown mount, unknown action, action input that fails the
 *      action's schema, invalid input for `--peer`), or no daemon (`Required`,
 *      transport error)
 *   2: runtime error (local action returned Err, or remote RPC failed)
 *   3: peer not found (`--peer <target>` did not resolve within `--wait`)
 */

import type { DispatchError } from '@epicenter/workspace';
import {
	type DaemonError,
	getDaemon,
	type PeerSyncStatus,
	type RunError,
} from '@epicenter/workspace/node';
import { extractErrorMessage } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

import { cmd } from '../util/cmd.js';
import { projectOption } from '../util/common-options.js';
import {
	fail,
	formatOptions,
	type OutputFormat,
	output,
} from '../util/format-output.js';
import { parseJsonInput, readStdin } from '../util/parse-input.js';

export const runCommand = cmd({
	command: 'run <action> [input]',
	describe:
		'Invoke a defineQuery / defineMutation by action key, locally or on a remote peer (--peer)',
	builder: (yargs) =>
		yargs
			.positional('action', {
				type: 'string',
				demandOption: true,
				describe: 'Mount-prefixed action path, e.g. notes.notes_add',
			})
			.positional('input', {
				type: 'string',
				describe: 'Inline JSON or @file.json',
			})
			.option('C', projectOption)
			.option('peer', {
				type: 'string',
				description: 'Dispatch to a remote peer by peer id',
			})
			.option('wait', {
				type: 'number',
				description:
					'RPC deadline in ms for the peer call; requires --peer (daemon default: 5000)',
			})
			.implies('wait', 'peer')
			.options(formatOptions)
			.strict(),
	handler: async (argv) => {
		if (argv.peer !== undefined && argv.peer.length === 0) {
			fail(
				'--peer requires a peer id; run `epicenter peers` to see who is online',
			);
			return;
		}
		const actionInput = await resolveInput(argv.input);

		const { data: daemon, error: daemonErr } = await getDaemon(argv.C);
		if (daemonErr) {
			fail(daemonErr.message);
			return;
		}

		// A `peer` key with an `undefined` value drops out of the JSON wire
		// body, so a local run sends no peer fields at all.
		const result = await daemon.run({
			actionPath: argv.action,
			input: actionInput,
			peer:
				argv.peer === undefined
					? undefined
					: { to: argv.peer, waitMs: argv.wait },
		});
		renderRunResult(result, argv.format);
	},
});

function renderRunResult(
	result: Result<unknown, RunError | DaemonError>,
	format: OutputFormat | undefined,
): void {
	if (result.error === null) {
		output(result.data, { format });
		return;
	}
	switch (result.error.name) {
		case 'UsageError': {
			const details = result.error.suggestions?.length
				? ['', 'Exposed actions at this key:', ...result.error.suggestions]
				: [];
			fail(result.error.message, { details });
			return;
		}
		case 'RuntimeError':
			fail(result.error.message, { code: 2 });
			return;
		case 'PeerNotFound':
			emitPeerNotFound(
				result.error.to,
				result.error.waitMs,
				result.error.syncStatus,
			);
			return;
		case 'RemoteCallFailed':
			emitRemoteCallError(result.error.to, result.error.cause);
			return;
		case 'Required':
		case 'Timeout':
		case 'Unreachable':
		case 'HandlerCrashed':
			fail(result.error.message);
			return;
		default:
			result.error satisfies never;
			return;
	}
}

async function resolveInput(input: string | undefined): Promise<unknown> {
	const positional = input && input.length > 0 ? input : undefined;
	const stdinContent = await readStdin();
	return parseJsonInput({ positional, stdinContent });
}

function emitPeerNotFound(
	target: string,
	waitMs: number,
	syncStatus: PeerSyncStatus,
): void {
	const details = [`  reason: ${describePeerMissReason(syncStatus)}`];
	if (syncStatus.phase === 'connected') {
		details.push('run `epicenter peers` to see connected peers');
	}
	fail(`no peer matches peer id "${target}" after ${waitMs}ms`, {
		code: 3,
		details,
	});
}

/**
 * Format every `DispatchError` variant labeled with the peer target. The
 * exhaustive switch is enforced at compile time: adding a new variant to
 * `@epicenter/workspace`'s `DispatchError` breaks the build until a case is
 * added here.
 */
export function emitRemoteCallError(
	peerTarget: string,
	cause: Exclude<DispatchError, { name: 'RecipientOffline' }>,
): void {
	switch (cause.name) {
		case 'Cancelled':
			// The daemon owns the dispatch `AbortSignal` (`AbortSignal.timeout(waitMs)`
			// in action-handler.ts), so a `Cancelled` dispatch error that reaches the
			// CLI is always the `--wait` deadline. Its abort reason is a
			// `DOMException`, which cannot survive the daemon's JSON response, so
			// it is not inspected here.
			fail(`timeout calling ${peerTarget}`, { code: 2 });
			return;
		case 'ActionNotFound':
			fail(`ActionNotFound "${cause.action}" on ${peerTarget}`, { code: 2 });
			return;
		case 'ActionFailed':
			fail(`"${cause.action}" failed on ${peerTarget}: ${cause.cause}`, {
				code: 2,
			});
			return;
		case 'NetworkFailed':
			fail(
				`dispatch to ${peerTarget} failed: ${extractErrorMessage(cause.cause)}`,
				{ code: 2 },
			);
			return;
		default:
			cause satisfies never;
	}
}

function describePeerMissReason(status: PeerSyncStatus): string {
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
