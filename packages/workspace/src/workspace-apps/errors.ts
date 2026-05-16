/**
 * Structured errors for folder-routed daemon extension discovery and startup.
 *
 * Discovery surfaces `WorkspaceFolderInvalid`, `WorkspaceFolderCollision`, and
 * `WorkspaceDaemonMissing` when scanning `<projectDir>/workspaces/*`.
 * Daemon-entry validation surfaces `WorkspaceDaemonInvalidExport`. Startup
 * wraps any throw from a daemon's `open(ctx)` in `WorkspaceOpenFailed` so
 * callers can dispose siblings on failure.
 */

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';

export const WorkspaceAppError = defineErrors({
	WorkspaceFolderInvalid: ({
		folderName,
		workspaceDir,
		reason,
	}: {
		folderName: string;
		workspaceDir: string;
		reason: 'invalid-name' | 'not-a-directory';
	}) => ({
		message:
			reason === 'invalid-name'
				? `Invalid workspace folder name "${folderName}" at ${workspaceDir}: use letters, numbers, "_" or "-", and avoid reserved object keys.`
				: `Workspace entry "${folderName}" at ${workspaceDir} is not a directory.`,
		folderName,
		workspaceDir,
		reason,
	}),
	WorkspaceFolderCollision: ({
		route,
		folderNames,
	}: {
		route: string;
		folderNames: readonly string[];
	}) => ({
		message:
			`Case-insensitive workspace folder collision for route "${route}": ` +
			`folders ${folderNames.map((name) => `"${name}"`).join(', ')} resolve to the same route name.`,
		route,
		folderNames,
	}),
	WorkspaceDaemonMissing: ({
		route,
		daemonEntryPath,
	}: {
		route: string;
		daemonEntryPath: string;
	}) => ({
		message: `Workspace "${route}" is missing a daemon entrypoint at ${daemonEntryPath}.`,
		route,
		daemonEntryPath,
	}),
	WorkspaceDaemonInvalidExport: ({
		route,
		daemonEntryPath,
	}: {
		route: string;
		daemonEntryPath: string;
	}) => ({
		message:
			`Workspace "${route}" daemon at ${daemonEntryPath} has an invalid default export: ` +
			`expected an object with an open(ctx) function (see defineDaemonWorkspace).`,
		route,
		daemonEntryPath,
	}),
	WorkspaceOpenFailed: ({
		route,
		daemonEntryPath,
		cause,
	}: {
		route: string;
		daemonEntryPath: string;
		cause: unknown;
	}) => ({
		message:
			`Workspace "${route}" failed to open at ${daemonEntryPath}: ` +
			extractErrorMessage(cause),
		route,
		daemonEntryPath,
		cause,
	}),
});

export type WorkspaceAppError = InferErrors<typeof WorkspaceAppError>;
