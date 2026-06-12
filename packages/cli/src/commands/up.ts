/**
 * `epicenter daemon up`: start the long-lived foreground daemon for one project.
 *
 * Loads every mount declared in `epicenter.config.ts`, opens each one in
 * parallel, and exposes a Unix-socket IPC channel for that project. `peers`,
 * `list`, and `run` dispatch to this daemon over IPC; without `daemon up`
 * they error with a hint pointing back here.
 *
 * One daemon per project; that daemon serves every configured mount.
 * Resource isolation between mounts is expressed by splitting them into
 * different projects, not by a flag.
 *
 * Foreground by design; backgrounding is the user's job.
 */

import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SyncAuthClient } from '@epicenter/auth';
import {
	createMachineAuthClient,
	type MachineAuthStorageError,
} from '@epicenter/auth/node';
import type { StartedMount } from '@epicenter/workspace/daemon';
import {
	claimDaemonLease,
	type DaemonMetadata,
	findProjectRoot,
	openProject,
	type ProjectConfigError,
	StartupError,
	startDaemonServer,
	unlinkMetadata,
	type WorkspaceAppError,
	writeMetadata,
} from '@epicenter/workspace/node';
import { Ok, type Result, trySync } from 'wellcrafted/result';
import packageJson from '../../package.json' with { type: 'json' };
import { cmd } from '../util/cmd.js';

const CLI_VERSION = packageJson.version;

const upProjectOption = {
	type: 'string' as const,
	description:
		'Project root, or any directory under it (discovery walks up to the nearest epicenter.config.ts).',
	default: () => process.cwd(),
	defaultDescription: 'current working directory',
	coerce: (projectDir: string) => projectDir,
};

/**
 * Sync-status / presence lines write directly to stderr so they reach the
 * operator regardless of `--quiet`; the brief calls these out as "print
 * regardless of --quiet". `--quiet` only suppresses peer join/leave lines
 * (handled at their call sites), not these.
 */
function logSyncStatus(message: string): void {
	process.stderr.write(`${message}\n`);
}

type UpOptions = {
	projectDir: string;
	quiet: boolean;
	cliVersion?: string;
	/**
	 * Factory that constructs the daemon's auth client. Production uses the
	 * default (`createMachineAuthClient`, which reads the persisted cell from
	 * disk). Tests pass a stub or a deliberately-failing factory to exercise
	 * the auth-construction seam without seeding files or mutating env vars.
	 */
	createAuthClient?: () => Promise<
		Result<SyncAuthClient, MachineAuthStorageError>
	>;
};

/**
 * Handle returned by {@link runUp}. The daemon body is exposed as a
 * standalone async function (no `process.exit`) so unit tests can drive
 * startup, exercise the IPC handler in-process, and call `teardown()` to
 * release resources without spawning a child.
 *
 * - `mounts` is every started mount runtime the project declares; the daemon
 *   serves them all and routes IPC requests by mount name.
 * - `metadata` is what was written to disk.
 * - `teardown()` closes the server, asyncDisposes the runtimes, releases the
 *   lease, and unlinks metadata + socket. Idempotent.
 */
type UpHandle = {
	mounts: StartedMount[];
	metadata: DaemonMetadata;
	teardown: () => Promise<void>;
};

/**
 * Daemon body. Opens every configured mount (the project must already have an
 * `epicenter.config.ts`; see `epicenter init`), ensures the `.epicenter`
 * cache gitignore, binds the IPC socket, and returns a handle. The yargs
 * `handler` calls this,
 * prints the operator-facing banner, installs SIGINT/SIGTERM, and parks the
 * process; tests call it directly and assert on the returned handle.
 *
 * A SQLite daemon lease claims ownership before any mount opens. After that,
 * `openProject` imports `epicenter.config.ts` and opens every configured
 * mount, and `startDaemonServer` binds the socket.
 */
export async function runUp(
	options: UpOptions,
): Promise<
	Result<
		UpHandle,
		| ProjectConfigError
		| WorkspaceAppError
		| StartupError
		| MachineAuthStorageError
	>
> {
	const projectDir = realpathSync(resolveProjectForUp(options.projectDir));

	const leaseResult = claimDaemonLease(projectDir);
	if (leaseResult.error !== null) return leaseResult;
	const lease = leaseResult.data;

	const metadata: DaemonMetadata = {
		pid: process.pid,
		dir: projectDir,
		startedAt: new Date().toISOString(),
		cliVersion: options.cliVersion ?? CLI_VERSION,
		discoveredAt: new Date().toISOString(),
	};

	// Ordered unwinding for partially-completed startup. Each resource
	// registers its disposer as it is acquired; `AsyncDisposableStack` runs
	// them in reverse. On any early `return` or `throw` before `stack.move()`,
	// `await using` disposes exactly what was acquired. On success, `move()`
	// transfers the stack to the caller as the returned `teardown`.
	await using stack = new AsyncDisposableStack();
	stack.defer(() => lease.release());

	const createAuthClient = options.createAuthClient ?? createMachineAuthClient;
	const authResult = await createAuthClient();
	if (authResult.error) return authResult;
	const auth = authResult.data;
	stack.defer(() => auth[Symbol.dispose]());

	const startResult = await openProject({ projectDir, auth });
	if (startResult.error) return startResult;
	const mounts = startResult.data;
	ensureProjectGitignore(projectDir);
	stack.defer(() =>
		Promise.allSettled(
			mounts.map((entry) =>
				Promise.resolve(entry.runtime[Symbol.asyncDispose]()),
			),
		).then(() => undefined),
	);

	const serverResult = await startDaemonServer({ lease, mounts });
	if (serverResult.error) return serverResult;
	const daemonServer = serverResult.data;
	stack.defer(() => daemonServer.close());

	const metadataResult = trySync({
		try: () => writeMetadata(projectDir, metadata),
		catch: (cause) => StartupError.MetadataWriteFailed({ cause }),
	});
	if (metadataResult.error) return metadataResult;
	stack.defer(() => unlinkMetadata(projectDir));

	const teardownStack = stack.move();
	return Ok({
		mounts,
		metadata,
		teardown: () => teardownStack.disposeAsync(),
	});
}

/**
 * Yargs `daemon up` command. Thin glue: parses argv, calls {@link runUp}, prints
 * the operator-facing banner + initial peers snapshot, wires SIGINT/SIGTERM,
 * subscribes to presence/status across every loaded mount, and parks
 * until a signal triggers teardown.
 */
export const upCommand = cmd({
	command: 'up',
	describe:
		'Open every mount in epicenter.config.ts and serve them on the daemon socket (foreground).',
	builder: {
		C: upProjectOption,
		quiet: {
			type: 'boolean',
			default: false,
			description:
				'Suppress peer join/leave lines (sync state changes still print)',
		},
	},
	handler: async (argv) => {
		const options: UpOptions = {
			projectDir: argv.C,
			quiet: argv.quiet,
		};

		const { data: handle, error } = await runUp(options);
		if (error) {
			process.stderr.write(`${error.message}\n`);
			if (error.name === 'ProjectConfigNotFound') {
				process.stderr.write(
					'run `epicenter init` to scaffold a project here\n',
				);
			}
			process.exit(1);
		}

		const mountNames = handle.mounts.map((entry) => entry.mount).join(', ');
		logSyncStatus(`online (mounts=[${mountNames}])`);

		for (const entry of handle.mounts) {
			printPeersSnapshot(entry);
			subscribePeers(entry, options.quiet);
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

function resolveProjectForUp(start: string): string {
	try {
		return findProjectRoot(start);
	} catch {
		return resolve(start);
	}
}

/**
 * Ensure `.epicenter/` exists (0o700) and is fully gitignored. The attach
 * primitives (Yjs log, SQLite and markdown materializers) create their own
 * data dirs on demand, so the daemon's only filesystem provisioning is the
 * cache-dir ignore rule. `*` ignores everything the runtime ever writes,
 * including this file, so there is no directory list to keep in sync.
 * Project creation itself (writing `epicenter.config.ts`) is `epicenter
 * init`; `daemon up` on a directory without a config fails with a hint
 * instead of silently scaffolding a project.
 */
function ensureProjectGitignore(projectDir: string): void {
	const projectDataDir = join(projectDir, '.epicenter');
	mkdirSync(projectDataDir, { recursive: true, mode: 0o700 });
	const gitignorePath = join(projectDataDir, '.gitignore');
	if (!existsSync(gitignorePath)) {
		writeFileSync(gitignorePath, '*\n', { mode: 0o600 });
	}
}

function printPeersSnapshot(entry: StartedMount): void {
	const devices = entry.runtime.collaboration.devices.list();
	if (devices.length === 0) {
		process.stderr.write(`${entry.mount}: no peers connected\n`);
		return;
	}
	for (const device of devices) {
		process.stderr.write(`${entry.mount}: peer ${device.deviceId}\n`);
	}
}

function subscribePeers(entry: StartedMount, quiet: boolean): void {
	const snapshot = () =>
		new Set(
			entry.runtime.collaboration.devices
				.list()
				.map((device) => device.deviceId),
		);
	let prev = snapshot();
	entry.runtime.collaboration.devices.subscribe(() => {
		const next = snapshot();
		for (const deviceId of next) {
			if (!prev.has(deviceId)) {
				if (!quiet) {
					process.stderr.write(`${entry.mount}: ${deviceId} joined\n`);
				}
			}
		}
		for (const deviceId of prev) {
			if (!next.has(deviceId)) {
				if (!quiet) {
					process.stderr.write(`${entry.mount}: ${deviceId} left\n`);
				}
			}
		}
		prev = next;
	});
}

function subscribeSyncStatus(entry: StartedMount): void {
	entry.runtime.collaboration.onStatusChange((status) => {
		if (status.phase === 'connecting') {
			logSyncStatus(`${entry.mount}: connecting (retry ${status.retries})`);
		} else if (status.phase === 'connected') {
			logSyncStatus(`${entry.mount}: connected`);
		} else if (status.phase === 'offline') {
			logSyncStatus(`${entry.mount}: offline`);
		}
	});
}
