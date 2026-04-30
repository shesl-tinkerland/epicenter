/**
 * `epicenter up`: start the long-lived foreground daemon for one project.
 *
 * Loads every workspace exported by `epicenter.config.ts` and exposes a
 * Unix-socket IPC channel for that project. `peers`, `list`, and `run`
 * dispatch to this daemon over IPC; without `up` they error with a hint
 * pointing back here.
 *
 * One daemon per project; that daemon serves every workspace the config
 * exports (Invariant 7). Resource isolation between workspaces is
 * expressed by splitting them into different config dirs, not by a flag.
 *
 * Foreground by design; backgrounding is the user's job (see Invariant 5
 * in the design spec).
 *
 * See spec: `20260426T235000-cli-up-long-lived-peer.md` § "Process lifecycle",
 * § "Logging", § "Invariants".
 */

import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
	createWorkspaceServer,
	type DaemonMetadata,
	type StartupError,
	socketPathFor,
	type UnixSocketServer,
	unlinkMetadata,
	unlinkSocketFile,
	writeMetadata,
} from '@epicenter/workspace/node';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result, tryAsync } from 'wellcrafted/result';
import { defineCommand } from 'citty';
import {
	CONFIG_FILENAME,
	type LoadConfigResult,
	type LoadError,
	loadConfig,
	type WorkspaceEntry,
} from '../load-config.js';
import { projectArg, resolveProjectArg } from '../util/common-options.js';

/**
 * Hardcoded ceiling on how long any single workspace's `whenConnected`
 * may hang before `up` gives up on startup. This exists *only* because
 * `@epicenter/workspace`'s sync layer doesn't reject `whenConnected` on
 * permanent auth failures (it just retries forever); without a clock, an
 * expired token would freeze the daemon's startup indefinitely.
 *
 * Tracked: `specs/20260427T120000-workspace-sync-failed-phase.md`. When
 * the workspace package surfaces a `failed` SyncStatus phase and rejects
 * `whenConnected` accordingly, this constant and the `raceTimeout` call
 * site go away.
 */
const CONNECT_TIMEOUT_MS = 10000;

/**
 * Read once at module load. Bun resolves the JSON import relative to this
 * file at build/run time, so no runtime fs work happens per `up` invocation.
 */
import packageJson from '../../package.json' with { type: 'json' };

const CLI_VERSION = packageJson.version;

/**
 * Sync-status / awareness lines write directly to stderr so they reach the
 * operator regardless of `--quiet`; the brief calls these out as "print
 * regardless of --quiet". `--quiet` only suppresses awareness join/leave
 * lines (handled at their call sites), not these.
 */
function logSyncStatus(message: string): void {
	process.stderr.write(`${message}\n`);
}

export type UpConfig = {
	projectDir: string;
	quiet: boolean;
	cliVersion?: string;
};

/**
 * `runUp`'s own failure variant: a workspace's `whenReady` /
 * `whenConnected` didn't resolve within the connect timeout. The cause
 * from `raceTimeout` already carries the entry name + reason.
 *
 * Config-load failures come from {@link LoadError} (in `load-config.ts`)
 * and bind failures from {@link StartupError} (in `unix-socket.ts`); both
 * unioned into the return type rather than re-wrapped. The CLI command
 * doesn't care which union it came from: `error.message` and exit-1
 * either way.
 */
export const RunUpError = defineErrors({
	ConnectFailed: ({ cause }: { cause: unknown }) => ({
		message: extractErrorMessage(cause),
		cause,
	}),
});
export type RunUpError = InferErrors<typeof RunUpError>;

/**
 * Handle returned by {@link runUp}. The daemon body is exposed as a
 * standalone async function (no `process.exit`) so unit tests can drive
 * startup, exercise the IPC handler in-process, and call `teardown()` to
 * release resources without spawning a child.
 *
 * - `server` is the bound `net.Server` (handler dispatches IPC frames).
 * - `entries` is every workspace the config exports; the daemon serves
 *   them all and routes IPC requests by name.
 * - `metadata` is what was written to disk.
 * - `teardown()` closes the server, asyncDisposes the config, and unlinks
 *   metadata + socket. Idempotent.
 */
export type UpHandle = {
	server: UnixSocketServer;
	entries: WorkspaceEntry[];
	config: LoadConfigResult;
	metadata: DaemonMetadata;
	socketPath: string;
	teardown: () => Promise<void>;
};

/**
 * Surface for swapping out config/server construction in tests. The CLI
 * handler passes the production defaults; `up.test.ts` passes fakes.
 */
export type RunUpDeps = {
	loadConfig?: (dir: string) => Promise<Result<LoadConfigResult, LoadError>>;
	/**
	 * Test-only override for {@link CONNECT_TIMEOUT_MS}. Production has no
	 * way to tune this; it's a stopgap until the workspace package's
	 * sync layer rejects `whenConnected` on permanent auth failure (spec:
	 * `20260427T120000-workspace-sync-failed-phase.md`).
	 */
	connectTimeoutMs?: number;
};

/**
 * Daemon body. Idempotently sets up disk state, connects every workspace
 * the config exports, binds the IPC socket, and returns a handle. The
 * CLI command calls this, prints the operator-facing banner, installs
 * SIGINT/SIGTERM, and parks the process; tests call it directly and
 * assert on the returned handle.
 *
 * If any workspace fails to connect within the timeout, the whole daemon
 * fails. Partial-up is muddy semantics ("which subset is online?") and we
 * already have a way to express "I want only this one online": split the
 * config.
 */
export async function runUp(
	options: UpConfig,
	deps: RunUpDeps = {},
): Promise<Result<UpHandle, RunUpError | LoadError | StartupError>> {
	const projectDir = resolve(options.projectDir);
	const socketPath = socketPathFor(projectDir);

	const loader = deps.loadConfig ?? loadConfig;
	const loadResult = await loader(projectDir);
	if (loadResult.error) return loadResult;
	const config = loadResult.data;

	// Wait for every workspace's "ready to accept RPC" gate concurrently.
	// One bad workspace fails the whole daemon; see runUp's docstring.
	const connectResult = await tryAsync({
		try: () =>
			Promise.all(
				config.entries.map((entry) =>
					raceTimeout(
						entry.workspace.whenReady ??
							entry.workspace.sync?.whenConnected ??
							Promise.resolve(),
						deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
						() => connectFailedMessage(entry),
					),
				),
			),
		catch: (cause) => RunUpError.ConnectFailed({ cause }),
	});
	if (connectResult.error) {
		await safeAsyncDispose(config);
		return connectResult;
	}

	// Bind before writing our metadata. On AlreadyRunning the live
	// daemon's sidecar must stay intact; on a stale-socket recovery
	// `bindOrRecover` unlinks the orphan metadata internally before our
	// successful retry, so the writeMetadata below records *our* pid.
	const workspaceServer = createWorkspaceServer({
		projectDir,
		workspaces: config.entries,
		triggerShutdown: () => void teardown(),
	});
	const bindResult = await workspaceServer.listen();
	if (bindResult.error) {
		await safeAsyncDispose(config);
		return bindResult;
	}
	const server = bindResult.data;

	const configMtime = readConfigMtime(projectDir);
	const metadata: DaemonMetadata = {
		pid: process.pid,
		dir: projectDir,
		startedAt: new Date().toISOString(),
		cliVersion: options.cliVersion ?? CLI_VERSION,
		configMtime,
	};
	writeMetadata(projectDir, metadata);

	let teardownPromise: Promise<void> | null = null;
	const teardown = (): Promise<void> => {
		if (teardownPromise) return teardownPromise;
		teardownPromise = (async () => {
			try {
				server.stop();
			} catch {
				// best-effort
			}
			await safeAsyncDispose(config);
			unlinkMetadata(projectDir);
			unlinkSocketFile(socketPath);
		})();
		return teardownPromise;
	};

	return Ok({
		server,
		entries: config.entries,
		config,
		metadata,
		socketPath,
		teardown,
	});
}

/**
 * `up` command. Thin glue: parses args, calls {@link runUp}, prints
 * the operator-facing banner + initial peers snapshot, wires SIGINT/SIGTERM,
 * subscribes to awareness/status across every loaded workspace, and parks
 * until a signal triggers teardown.
 */
export const upCommand = defineCommand({
	meta: {
		name: 'up',
		description:
			'Bring this config online as a long-lived peer for every workspace it exports (foreground).',
	},
	args: {
		project: projectArg,
		quiet: {
			type: 'boolean',
			default: false,
			description:
				'Suppress awareness join/leave lines (sync state changes still print)',
		},
	},
	run: async ({ args }) => {
		const options: UpConfig = {
			projectDir: resolveProjectArg(args.project),
			quiet: args.quiet,
		};

		const { data: handle, error } = await runUp(options);
		if (error) {
			process.stderr.write(`${error.message}\n`);
			process.exit(1);
		}

		const names = handle.entries.map((e) => e.name).join(', ');
		logSyncStatus(`online (workspaces=[${names}])`);

		for (const entry of handle.entries) {
			printPeersSnapshot(entry);
			subscribeAwareness(entry, options.quiet);
			subscribeSyncStatus(entry);
		}

		const onSignal = () => {
			void handle.teardown().then(
				() => process.exit(0),
				() => process.exit(1),
			);
		};
		process.once('SIGINT', onSignal);
		process.once('SIGTERM', onSignal);

		// Park: don't exit. SIGINT/SIGTERM handler clears stdin so node can drain.
		process.stdin.resume();
	},
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function raceTimeout<T>(
	promise: Promise<T>,
	ms: number,
	onTimeoutMessage: () => string,
): Promise<T> {
	return new Promise<T>((res, rej) => {
		const t = setTimeout(() => {
			rej(new Error(`connect failed: ${onTimeoutMessage()}`));
		}, ms);
		promise.then(
			(v) => {
				clearTimeout(t);
				res(v);
			},
			(cause) => {
				clearTimeout(t);
				const msg = cause instanceof Error ? cause.message : String(cause);
				rej(new Error(`connect failed: ${msg}`));
			},
		);
	});
}

/**
 * Best-effort message synthesis when `whenReady` doesn't resolve. Today's
 * SyncAttachment exposes a `status` enum (`offline`/`connecting`/`connected`)
 * with a `lastError` tag (`auth` | `connection`); we promote `auth` to the
 * spec's `401 Unauthorized` phrasing so the acceptance criterion at least
 * matches the prefix. Once the workspace surfaces structured auth errors
 * through `whenReady` / `whenConnected`, this becomes precise.
 */
function connectFailedMessage(entry: WorkspaceEntry): string {
	const status = entry.workspace.sync?.status;
	if (
		status &&
		status.phase === 'connecting' &&
		status.lastError?.type === 'auth'
	) {
		return `${entry.name}: 401 Unauthorized. Try \`epicenter auth login\`.`;
	}
	return `${entry.name}: timed out waiting for workspace ready`;
}

function readConfigMtime(absDir: string): number {
	const p = join(absDir, CONFIG_FILENAME);
	try {
		return statSync(p).mtimeMs;
	} catch {
		return 0;
	}
}

async function safeAsyncDispose(config: LoadConfigResult): Promise<void> {
	try {
		await config[Symbol.asyncDispose]();
	} catch {
		// Best-effort cleanup; the daemon is exiting anyway.
	}
}

function printPeersSnapshot(entry: WorkspaceEntry): void {
	const peers = entry.workspace.presence?.peers();
	if (!peers || peers.size === 0) {
		process.stderr.write(`${entry.name}: no peers connected\n`);
		return;
	}
	for (const [clientID, state] of peers) {
		process.stderr.write(
			`${entry.name}: peer ${state.peer.id} (clientID=${clientID}, name=${state.peer.name})\n`,
		);
	}
}

function subscribeAwareness(entry: WorkspaceEntry, quiet: boolean): void {
	const presence = entry.workspace.presence;
	if (!presence) return;
	let prev = new Map(presence.peers());
	presence.observe(() => {
		const next = presence.peers();
		for (const [clientID, state] of next) {
			if (!prev.has(clientID)) {
				if (!quiet) {
					process.stderr.write(
						`${entry.name}: ${state.peer.id} joined (clientID=${clientID})\n`,
					);
				}
			}
		}
		for (const [clientID, state] of prev) {
			if (!next.has(clientID)) {
				if (!quiet) {
					process.stderr.write(
						`${entry.name}: ${state.peer.id} left (clientID=${clientID})\n`,
					);
				}
			}
		}
		prev = new Map(next);
	});
}

function subscribeSyncStatus(entry: WorkspaceEntry): void {
	const sync = entry.workspace.sync;
	if (!sync) return;
	sync.onStatusChange((status) => {
		if (status.phase === 'connecting') {
			logSyncStatus(`${entry.name}: connecting (retry ${status.retries})`);
		} else if (status.phase === 'connected') {
			logSyncStatus(`${entry.name}: connected`);
		} else if (status.phase === 'offline') {
			logSyncStatus(`${entry.name}: offline`);
		}
	});
}
