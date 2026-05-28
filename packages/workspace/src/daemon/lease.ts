/**
 * Project daemon lease.
 *
 * The lease is the single ownership primitive for daemon startup and lifetime.
 * Sockets are IPC endpoints, metadata is diagnostics, and ping is liveness.
 * None of those decide ownership.
 *
 * SQLite gives us a cross-platform OS-backed lock through an open write
 * transaction. `BEGIN IMMEDIATE` fails with `SQLITE_BUSY` when another process
 * already holds the lease, and the OS releases the lock when the process dies
 * and the database handle closes.
 */

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Ok, type Result } from 'wellcrafted/result';

import { bestEffortSync } from './best-effort.js';
import { readMetadata } from './metadata.js';
import { leasePathFor, socketPathFor } from './paths.js';
import { StartupError } from './startup-errors.js';

function createDaemonLease({
	db,
	projectDir,
	leasePath,
}: {
	db: Database;
	projectDir: string;
	leasePath: string;
}) {
	let released = false;
	return {
		/** Filesystem-resolved absolute path that scopes this daemon. */
		projectDir,
		/** SQLite file whose open write transaction owns the daemon lease. */
		leasePath,
		/** Filesystem path of the unix socket this daemon binds. */
		socketPath: socketPathFor(projectDir),
		/** Release the daemon lease. Idempotent. */
		release(): void {
			if (released) return;
			released = true;
			bestEffortSync(() => {
				if (db?.inTransaction) db.run('ROLLBACK');
			});
			bestEffortSync(() => db?.close());
		},
	};
}

export type DaemonLease = ReturnType<typeof createDaemonLease>;

export function claimDaemonLease(
	projectDir: string,
): Result<DaemonLease, StartupError> {
	const leasePath = leasePathFor(projectDir);

	let db: Database | undefined;
	try {
		mkdirSync(dirname(leasePath), { recursive: true, mode: 0o700 });
		db = new Database(leasePath);
		db.run('PRAGMA busy_timeout = 0');
		db.run('BEGIN IMMEDIATE');
	} catch (cause) {
		bestEffortSync(() => db?.close());
		if (isSqliteBusy(cause)) {
			return StartupError.AlreadyRunning({
				pid: readMetadata(projectDir)?.pid,
			});
		}
		return StartupError.LeaseFailed({ cause });
	}

	return Ok(createDaemonLease({ db, projectDir, leasePath }));
}

function isSqliteBusy(cause: unknown): boolean {
	return (
		cause instanceof Error && 'code' in cause && cause.code === 'SQLITE_BUSY'
	);
}
