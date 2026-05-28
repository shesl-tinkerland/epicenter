import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { MountNameIssue } from './mount-validation.js';

/**
 * Tagged-error variants for daemon startup.
 *
 * - `AlreadyRunning`: another daemon owns this project lease or answers ping.
 * - `LeaseFailed`: the SQLite lease could not be opened or locked.
 * - `BindFailed`: `Bun.serve` raised on an unrecoverable bind error.
 * - `MountNameRejected`: embedded callers passed invalid mount names.
 * - `MetadataWriteFailed`: startup could not publish its metadata sidecar.
 *
 * Auth-construction failures are surfaced as `MachineAuthStorageError`
 * variants directly (see `@epicenter/auth`); they do not need a startup-
 * scope wrapper because `runUp` returns the original typed error.
 */
export const StartupError = defineErrors({
	AlreadyRunning: ({ pid }: { pid?: number }) => ({
		message: `daemon already running${pid !== undefined ? ` (pid=${pid})` : ''}`,
		pid,
	}),
	LeaseFailed: ({ cause }: { cause: unknown }) => ({
		message: `daemon lease failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	BindFailed: ({ cause }: { cause: unknown }) => ({
		message: `bind failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	MountNameRejected: ({ mount, reason }: MountNameIssue) => ({
		message:
			reason === 'duplicate'
				? `duplicate mount '${mount}'`
				: `invalid mount name '${mount}'`,
		mount,
		reason,
	}),
	MetadataWriteFailed: ({ cause }: { cause: unknown }) => ({
		message: `daemon metadata write failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type StartupError = InferErrors<typeof StartupError>;
