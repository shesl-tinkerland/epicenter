/**
 * Structured errors for bringing a project's mount online.
 *
 * Startup refuses to open at all when machine auth is signed out, and wraps any
 * throw from the mount's `open(ctx)` in `MountOpenFailed`. Mount-name validity
 * is owned elsewhere: format at load (`ProjectConfigError`) and uniqueness over
 * the served set at bind (`StartupError`).
 */

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';

export const WorkspaceAppError = defineErrors({
	WorkspaceAuthSignedOut: () => ({
		message:
			'Cannot open mounts while machine auth is signed out. Run `epicenter auth login` first.',
	}),
	MountOpenFailed: ({ mount, cause }: { mount: string; cause: unknown }) => ({
		message: `Mount "${mount}" failed to open: ${extractErrorMessage(cause)}`,
		mount,
		cause,
	}),
});

export type WorkspaceAppError = InferErrors<typeof WorkspaceAppError>;
