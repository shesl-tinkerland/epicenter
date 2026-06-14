/**
 * Structured errors for bringing a project's mount online.
 *
 * Startup refuses to open when machine auth is signed out, refuses to adopt a
 * hand-populated mount folder before the namespace exists
 * (`MountFolderNotEmpty`), surfaces a failed namespace claim
 * (`EpicenterFolderClaimFailed`), and wraps any throw from the mount's
 * `open(ctx)` in `MountOpenFailed`. Mount-name validity is owned elsewhere:
 * format at load (`ProjectConfigError`) and uniqueness over the served set at
 * bind (`StartupError`).
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
	MountFolderNotEmpty: ({ mount, path }: { mount: string; path: string }) => ({
		message:
			`Refusing to start: "${path}" already has files, but this Epicenter folder has no .epicenter/ state yet. ` +
			`Epicenter generates and rebuilds the "${mount}" folder from synced data, so it will not adopt files you put there by hand. ` +
			`Move them elsewhere (or rename the "${mount}" mount), then run \`epicenter daemon up\` again.`,
		mount,
		path,
	}),
	EpicenterFolderClaimFailed: ({
		epicenterRoot,
		cause,
	}: {
		epicenterRoot: string;
		cause: unknown;
	}) => ({
		message: `Failed to claim Epicenter folder "${epicenterRoot}": ${extractErrorMessage(cause)}`,
		epicenterRoot,
		cause,
	}),
	MountOpenFailed: ({ mount, cause }: { mount: string; cause: unknown }) => ({
		message: `Mount "${mount}" failed to open: ${extractErrorMessage(cause)}`,
		mount,
		cause,
	}),
});

export type WorkspaceAppError = InferErrors<typeof WorkspaceAppError>;
