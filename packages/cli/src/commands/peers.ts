/**
 * `epicenter peers`: live-node view of who's connected right now.
 *
 * Shows the node id needed to target a peer with `run --peer`.
 * The relay carries only `nodeId` on the wire; product-level
 * display names live in app-owned state and are out of scope here.
 *
 * `epicenter peers` requires a running daemon for the discovered Epicenter root.
 * Without `daemon up`, the handler errors with a hint pointing at
 * `epicenter daemon up`.
 *
 * Prints `no peers connected` to stderr when every workspace is empty (text
 * mode only; JSON mode always emits a valid array, even if empty).
 */

import { getDaemon, type PeerSnapshot } from '@epicenter/workspace/node';
import { cmd } from '../util/cmd.js';
import { epicenterRootOption } from '../util/common-options.js';
import {
	fail,
	formatOptions,
	type OutputFormat,
	output,
} from '../util/format-output.js';

export const peersCommand = cmd({
	command: 'peers',
	describe: 'List connected peers (presence)',
	builder: {
		C: epicenterRootOption,
		...formatOptions,
	},
	handler: async (argv) => {
		const { data: daemon, error: daemonErr } = await getDaemon(argv.C);
		if (daemonErr) {
			fail(daemonErr.message);
			return;
		}
		const { data: rows, error } = await daemon.peers();
		if (error) {
			fail(error.message);
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

	console.table(
		rows
			.map((snap) => ({ nodeId: snap.nodeId }))
			.sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
	);
}
