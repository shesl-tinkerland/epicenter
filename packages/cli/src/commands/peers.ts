/**
 * `epicenter peers`: live-device view of who's connected right now.
 *
 * Shows the device id needed to target a peer with `run --peer`.
 * The relay carries only `deviceId` on the wire; product-level
 * display names live in app-owned state and are out of scope here.
 *
 * `epicenter peers` requires a running daemon for the discovered project.
 * Without `daemon up`, the handler errors with a hint pointing at
 * `epicenter daemon up`.
 *
 * Prints `no peers connected` to stderr when every workspace is empty (text
 * mode only; JSON mode always emits a valid array, even if empty).
 */

import { getDaemon, type PeerSnapshot } from '@epicenter/workspace/node';
import { cmd } from '../util/cmd.js';
import { projectOption } from '../util/common-options.js';
import {
	formatOptions,
	type OutputFormat,
	output,
} from '../util/format-output.js';

export const peersCommand = cmd({
	command: 'peers',
	describe: 'List connected peers (presence)',
	builder: {
		C: projectOption,
		...formatOptions,
	},
	handler: async (argv) => {
		const { data: daemon, error: daemonErr } = await getDaemon(argv.C);
		if (daemonErr) {
			console.error(daemonErr.message);
			process.exitCode = 1;
			return;
		}
		const { data: rows, error } = await daemon.peers();
		if (error) {
			console.error(`error: ${error.message}`);
			process.exitCode = 1;
			return;
		}
		emit(rows, argv.format);
	},
});

function emit(rows: PeerSnapshot[], format: OutputFormat | undefined): void {
	if (format === 'json' || format === 'jsonl') {
		output(rows, { format });
		return;
	}

	if (rows.length === 0) {
		console.error('no peers connected');
		return;
	}

	const byMount = new Map<string, PeerSnapshot[]>();
	for (const row of rows) {
		const list = byMount.get(row.mount);
		if (list) list.push(row);
		else byMount.set(row.mount, [row]);
	}

	let i = 0;
	for (const [mount, group] of byMount) {
		if (i > 0) console.log('');
		console.log(mount);
		console.table(
			group
				.map((snap) => ({ deviceId: snap.deviceId }))
				.sort((a, b) => a.deviceId.localeCompare(b.deviceId)),
		);
		i++;
	}
}
