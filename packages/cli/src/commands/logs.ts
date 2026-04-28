/**
 * `epicenter logs`: tail the rotating log file for a running daemon.
 *
 * Default: print the last 50 lines and exit (mirrors `tail` defaults).
 * `--follow`: stream new bytes via `node:fs.watch`, reopening on rotation
 * (the watch event for `.log` → `.log.1` rename surfaces as `'rename'`).
 *
 * Without `--dir` we error if more than one daemon is running; with exactly
 * one we tail it for free. With zero daemons we exit 1 with a hint.
 *
 * See spec: `20260426T235000-cli-up-long-lived-peer.md` § "Logging".
 */

import {
	existsSync,
	openSync,
	readFileSync,
	readSync,
	closeSync,
	statSync,
	watch,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

import type { Argv, CommandModule } from 'yargs';

import {
	type DaemonMetadata,
	enumerateDaemons,
	readMetadata,
} from '../daemon/metadata.js';
import { logPathFor } from '../daemon/paths.js';
import { dirFromArgv, dirOption } from '../util/common-options.js';

const DEFAULT_TAIL_LINES = 50;

export type LogsOptions = {
	dir?: string;
	follow: boolean;
};

/**
 * Read the last `n` lines of `path` and return them joined by `\n` with a
 * trailing newline (matching `tail -n` output). Returns the empty string
 * when the file is missing or empty.
 *
 * Implementation note: `readFileSync` is fine here. The log is bounded
 * to {@link import('../daemon/log-rotation.js').ROTATE_MAX_BYTES} (10 MB)
 * before rotation, so worst-case memory is small and predictable.
 */
export function tailLines(path: string, n: number): string {
	if (!existsSync(path)) return '';
	const buf = readFileSync(path, 'utf8');
	if (buf.length === 0) return '';
	const lines = buf.split('\n');
	// `split` of "a\nb\n" → ['a','b',''], so drop the trailing empty if present.
	if (lines[lines.length - 1] === '') lines.pop();
	return `${lines.slice(-n).join('\n')}\n`;
}

/**
 * Resolve which daemon's log file to tail when `--dir` is omitted.
 *
 * Returns:
 *   - `{ kind: 'one', dir }`   when exactly one metadata file exists.
 *   - `{ kind: 'none' }`       when none.
 *   - `{ kind: 'many', dirs }` when more than one (caller must error).
 */
export function pickSoleDaemon():
	| { kind: 'one'; meta: DaemonMetadata }
	| { kind: 'none' }
	| { kind: 'many'; dirs: string[] } {
	const metas = enumerateDaemons();
	if (metas.length === 0) return { kind: 'none' };
	if (metas.length > 1) return { kind: 'many', dirs: metas.map((m) => m.dir) };
	return { kind: 'one', meta: metas[0]! };
}

/**
 * Stream new bytes appended to `path` to `process.stdout`. Reopens the
 * file when watch reports `'rename'` (the rotation event from
 * {@link import('../daemon/log-rotation.js').rotateIfNeeded}). The
 * returned function cancels the watcher.
 */
export function followLog(path: string): () => void {
	let fd = existsSync(path) ? openSync(path, 'r') : -1;
	let pos = fd >= 0 ? statSync(path).size : 0;

	const drain = () => {
		if (fd < 0) return;
		const size = (() => {
			try {
				return statSync(path).size;
			} catch {
				return -1;
			}
		})();
		if (size < 0) return;
		// File was truncated under us; reopen from start.
		if (size < pos) {
			closeSync(fd);
			fd = openSync(path, 'r');
			pos = 0;
		}
		const buf = Buffer.alloc(64 * 1024);
		while (pos < size) {
			const bytes = readSync(fd, buf, 0, buf.length, pos);
			if (bytes <= 0) break;
			process.stdout.write(buf.subarray(0, bytes));
			pos += bytes;
		}
	};

	// Watch the parent dir to catch rename → recreate.
	const watcher = watch(dirname(path), (eventType, fn) => {
		if (fn !== basename(path)) return;
		if (eventType === 'rename') {
			// File was rotated away or recreated; reopen.
			if (fd >= 0) {
				try {
					closeSync(fd);
				} catch {
					// best effort
				}
				fd = -1;
			}
			if (existsSync(path)) {
				fd = openSync(path, 'r');
				pos = 0;
				drain();
			}
			return;
		}
		// 'change': new bytes appended.
		drain();
	});
	// Best-effort initial drain (any bytes that arrived between open and watch).
	drain();
	return () => {
		watcher.close();
		if (fd >= 0) {
			try {
				closeSync(fd);
			} catch {
				// best effort
			}
		}
	};
}

export const logsCommand: CommandModule = {
	command: 'logs',
	describe: 'Tail the log file for a running daemon.',
	builder: (yargs: Argv) =>
		yargs
			.option('dir', { ...dirOption, default: undefined })
			.option('follow', {
				type: 'boolean',
				alias: 'f',
				default: false,
				description: 'Stream new lines as they are appended.',
			})
			.example(
				'$0 logs',
				'Print the last 50 lines of the sole running daemon (errors if more than one)',
			)
			.example(
				'$0 logs -f',
				'Stream new lines as they are appended (Ctrl-C to stop)',
			)
			.example(
				'$0 logs -C ~/notes -f',
				'Follow logs for a specific workspace directory',
			),
	handler: async (argv) => {
		const args = argv as Record<string, unknown>;
		const explicitDir = typeof args.dir === 'string' ? args.dir : undefined;
		const follow = args.follow === true;

		let logPath: string;
		if (explicitDir !== undefined) {
			const absDir = resolve(dirFromArgv(args));
			// readMetadata is best-effort; if missing, the log file may still
			// exist from a previous daemon. Fall through to logPathFor anyway.
			void readMetadata(absDir);
			logPath = logPathFor(absDir);
		} else {
			const sole = pickSoleDaemon();
			if (sole.kind === 'none') {
				process.stderr.write(
					'no daemons running; pass --dir to tail a specific log\n',
				);
				process.exit(1);
			}
			if (sole.kind === 'many') {
				process.stderr.write(
					`multiple daemons running; pass --dir <path>:\n  ${sole.dirs.join('\n  ')}\n`,
				);
				process.exit(1);
			}
			logPath = logPathFor(sole.meta.dir);
		}

		if (!existsSync(logPath) || statSync(logPath).size === 0) {
			process.stderr.write(`(log file empty or missing: ${logPath})\n`);
			if (!follow) return;
		} else {
			process.stdout.write(tailLines(logPath, DEFAULT_TAIL_LINES));
		}

		if (!follow) return;

		const stop = followLog(logPath);
		const stopAndExit = () => {
			stop();
			process.exit(0);
		};
		process.once('SIGINT', stopAndExit);
		process.once('SIGTERM', stopAndExit);
		// Park.
		await new Promise<void>(() => {
			/* never resolves */
		});
	},
};
