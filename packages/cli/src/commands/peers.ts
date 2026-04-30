/**
 * `epicenter peers`: presence view of who's connected right now.
 *
 * Shows the identity fields needed to target a peer with `run --peer`:
 * peer id, friendly name, platform, and the session-local clientID.
 *
 * `epicenter peers` requires a running daemon for the discovered project.
 * Without `up`, the handler errors with a hint pointing at `epicenter up`.
 *
 * Prints `no peers connected` to stderr when every workspace is empty (text
 * mode only; JSON mode always emits a valid array, even if empty).
 */

import { getDaemon, type PeerSnapshot } from '@epicenter/workspace/node';
import { defineCommand } from 'citty';
import { projectArg, resolveProjectArg } from '../util/common-options.js';
import {
	formatArgs,
	type OutputFormat,
	output,
	outputError,
} from '../util/format-output.js';

export const peersCommand = defineCommand({
	meta: {
		name: 'peers',
		description: 'List connected peers (presence)',
	},
	args: {
		project: projectArg,
		...formatArgs,
	},
	run: async ({ args }) => {
		const { data: daemon, error: daemonErr } = await getDaemon(
			resolveProjectArg(args.project),
		);
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
		emit(rows, args.format);
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

	const byExport = new Map<string, PeerSnapshot[]>();
	for (const row of rows) {
		const list = byExport.get(row.exportName);
		if (list) list.push(row);
		else byExport.set(row.exportName, [row]);
	}

	let i = 0;
	for (const [name, group] of byExport) {
		if (i > 0) console.log('');
		console.log(name);
		console.table(group.map(toRow).sort((a, b) => a.clientID - b.clientID));
		i++;
	}
}

function toRow(snap: PeerSnapshot) {
	return {
		clientID: snap.clientID,
		peerId: snap.peer.id,
		name: snap.peer.name,
		platform: snap.peer.platform,
	};
}
