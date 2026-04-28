/**
 * `epicenter peers`: presence view of who's connected right now.
 *
 * Shows the identity fields needed to target a peer with `run --peer`:
 * deviceId, friendly name, platform, and the session-local clientID.
 *
 * `epicenter peers` requires a running daemon for the resolved `--dir`.
 * Without `up`, the handler errors with a hint pointing at `epicenter up`.
 *
 * Prints `no peers connected` to stderr when every workspace is empty (text
 * mode only; JSON mode always emits a valid array, even if empty).
 */

import type { Argv, CommandModule } from 'yargs';

import type { PeerSnapshot } from '../daemon/app';
import { getDaemon } from '../daemon/client';
import { dirOption, resolveTarget, workspaceOption } from '../util/common-options';
import { formatYargsOptions, output, outputError } from '../util/format-output';

export const peersCommand: CommandModule = {
	command: 'peers',
	describe: 'List connected peers (presence)',
	builder: (yargs: Argv) =>
		yargs
			.option('dir', dirOption)
			.option('workspace', workspaceOption)
			.options(formatYargsOptions())
			.example('$0 peers', 'Table of currently connected peers')
			.example(
				'$0 peers --format json | jq -r \'.[].deviceId\'',
				'Just the deviceIds, one per line',
			)
			.example(
				'$0 peers --format jsonl | fzf | jq -r .deviceId',
				'Pick a peer interactively',
			),
	handler: async (argv) => {
		const args = argv as Record<string, unknown>;
		const target = resolveTarget(args);
		const format = args.format as 'json' | 'jsonl' | undefined;

		const { data: daemon, error: daemonErr } = await getDaemon(target);
		if (daemonErr) {
			outputError(daemonErr.message);
			process.exitCode = 1;
			return;
		}
		const { data: rows, error } = await daemon.peers();
		if (error) {
			outputError(`error: ${error.message}`);
			process.exitCode = 1;
			return;
		}
		const filtered =
			target.userWorkspace === undefined
				? rows
				: rows.filter((r) => r.workspace === target.userWorkspace);
		emit(filtered, {
			elideHeader: target.userWorkspace !== undefined,
			format,
		});
	},
};

function emit(
	rows: PeerSnapshot[],
	{
		elideHeader,
		format,
	}: { elideHeader: boolean; format: 'json' | 'jsonl' | undefined },
): void {
	if (format === 'json' || format === 'jsonl') {
		output(rows, { format });
		return;
	}

	if (rows.length === 0) {
		console.error('no peers connected');
		return;
	}

	const byWorkspace = new Map<string, PeerSnapshot[]>();
	for (const row of rows) {
		const list = byWorkspace.get(row.workspace);
		if (list) list.push(row);
		else byWorkspace.set(row.workspace, [row]);
	}

	let i = 0;
	for (const [name, group] of byWorkspace) {
		if (!elideHeader) {
			if (i > 0) console.log('');
			console.log(name);
		}
		console.table(group.map(toRow).sort((a, b) => a.clientID - b.clientID));
		i++;
	}
}

function toRow(snap: PeerSnapshot) {
	return {
		clientID: snap.clientID,
		deviceId: snap.device.id,
		name: snap.device.name,
		platform: snap.device.platform,
	};
}
