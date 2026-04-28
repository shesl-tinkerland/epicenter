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

import pc from 'picocolors';
import type { Argv, CommandModule } from 'yargs';

import type { PeerSnapshot } from '../daemon/app';
import { getDaemon } from '../daemon/client';
import { dirOption, resolveTarget, workspaceOption } from '../util/common-options';
import { fail, formatYargsOptions, output, outputError } from '../util/format-output';

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
			fail(daemonErr.message);
			return;
		}
		const { data: rows, error } = await daemon.peers();
		if (error) {
			fail(error.message);
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
		outputError('no peers connected');
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
			console.log(pc.bold(name));
		}
		printGroup(group.slice().sort((a, b) => a.clientID - b.clientID));
		i++;
	}
}

const COLS = ['CLIENT', 'DEVICE', 'NAME', 'PLATFORM'] as const;

function printGroup(snaps: PeerSnapshot[]): void {
	const rows = snaps.map((s) => [
		String(s.clientID),
		s.device.id,
		s.device.name,
		s.device.platform,
	]);
	const widths = COLS.map((h, i) =>
		Math.max(h.length, ...rows.map((r) => r[i]!.length)),
	);
	const pad = (vals: readonly string[]) =>
		vals.map((v, i) => v.padEnd(widths[i]!)).join('  ').trimEnd();
	console.log('  ' + pc.dim(pad(COLS)));
	for (const row of rows) console.log('  ' + pad(row));
}
