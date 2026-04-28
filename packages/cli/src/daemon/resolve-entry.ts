import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

import type { WorkspaceEntry } from '../load-config';

/**
 * Tagged-error variants returned by {@link resolveEntry}. Both are
 * user-facing (typo or missing `-w` flag), not panics, so they travel
 * in-band on the daemon wire and the renderer maps each to a clean
 * stderr message + `exitCode=1`.
 *
 * - `Unknown`: caller passed `--workspace foo`, no entry has that name.
 * - `Ambiguous`: multi-entry config and the caller didn't pass `-w`.
 */
export const ResolveError = defineErrors({
	UnknownWorkspace: ({
		requested,
		available,
	}: {
		requested: string;
		available: string[];
	}) => ({
		message: `no workspace '${requested}'. Available: ${available.join(', ')}`,
		requested,
		available,
	}),
	AmbiguousWorkspace: ({ available }: { available: string[] }) => ({
		message: `multiple workspaces found. Specify one with -w <name>. Available: ${available.join(', ')}`,
		available,
	}),
});
export type ResolveError = InferErrors<typeof ResolveError>;

/**
 * Resolve a single `WorkspaceEntry` from a config's exports.
 *
 *   - Caller passes a name and it matches an entry → `Ok(entry)`.
 *   - Caller passes nothing and there's exactly one entry → `Ok(entry)`.
 *   - Caller passes a name that doesn't match → `Err(UnknownWorkspace)`.
 *   - Caller passes nothing against a multi-entry config → `Err(AmbiguousWorkspace)`.
 *
 * Daemon route handlers fold this Err into the body `Result` so the user
 * sees a clean error, not `DaemonError.HandlerCrashed`.
 */
export function resolveEntry(
	entries: WorkspaceEntry[],
	workspace: string | undefined,
): Result<WorkspaceEntry, ResolveError> {
	const available = entries.map((e) => e.name);

	if (workspace !== undefined) {
		const entry = entries.find((e) => e.name === workspace);
		if (!entry)
			return ResolveError.UnknownWorkspace({ requested: workspace, available });
		return Ok(entry);
	}

	if (entries.length === 1) return Ok(entries[0]!);

	return ResolveError.AmbiguousWorkspace({ available });
}
