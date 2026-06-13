/**
 * Load a project's `epicenter.config.ts` and return its mount.
 *
 * The config default-exports a single `Mount`: one Epicenter folder is one app
 * is one mount.
 *
 *   `export default fuji();`
 *   `export default notes;`
 *
 * `epicenter.config.ts` is dynamically imported, so its default export crosses
 * a runtime boundary where TypeScript types are erased and nothing typechecks
 * the user's file first. `isMount` is therefore real input validation, not a
 * stand-in for a nominal type: it asserts the exact two members the daemon
 * consumes (`name: string`, `open: function`) so a malformed config fails with
 * a clear, structured error pointed at the file instead of a cryptic
 * `TypeError` deep in startup. The loader also owns the per-name format rule
 * (`isValidMountName`): the config file is the earliest point a bad name can be
 * caught, and the error points back at the file. (Uniqueness across a served
 * set of mounts is the daemon server's job, not the loader's.)
 *
 * Every failure is a `ProjectConfigError` variant; this function never throws.
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';

import type { Mount } from '../daemon/define-mount.js';
import { isValidMountName } from '../daemon/mount-validation.js';
import type { EpicenterRoot } from '../shared/types.js';
import { PROJECT_CONFIG_FILENAME } from './project-config-source.js';

export const ProjectConfigError = defineErrors({
	ProjectConfigNotFound: ({
		projectConfigPath,
	}: {
		projectConfigPath: string;
	}) => ({
		message: `Project config not found at ${projectConfigPath}`,
		projectConfigPath,
	}),
	ProjectConfigImportFailed: ({
		projectConfigPath,
		cause,
	}: {
		projectConfigPath: string;
		cause: unknown;
	}) => ({
		message: `Failed to load project config at ${projectConfigPath}: ${extractErrorMessage(cause)}`,
		projectConfigPath,
		cause,
	}),
	ProjectConfigInvalid: ({
		projectConfigPath,
		detail,
	}: {
		projectConfigPath: string;
		detail: string;
	}) => ({
		message: `Invalid project config at ${projectConfigPath}: ${detail}.`,
		projectConfigPath,
		detail,
	}),
});
export type ProjectConfigError = InferErrors<typeof ProjectConfigError>;

export async function loadProjectConfig(
	epicenterRoot: EpicenterRoot | string,
): Promise<Result<Mount, ProjectConfigError>> {
	const projectConfigPath = join(
		resolve(epicenterRoot),
		PROJECT_CONFIG_FILENAME,
	);
	if (!existsSync(projectConfigPath)) {
		return ProjectConfigError.ProjectConfigNotFound({ projectConfigPath });
	}

	const { data: module, error: importError } = await tryAsync({
		try: () =>
			import(pathToFileURL(projectConfigPath).href) as Promise<{
				default?: unknown;
			}>,
		catch: (cause) =>
			ProjectConfigError.ProjectConfigImportFailed({
				projectConfigPath,
				cause,
			}),
	});
	if (importError !== null) return Err(importError);

	const value = module.default;
	if (isMount(value)) {
		if (!isValidMountName(value.name)) {
			return ProjectConfigError.ProjectConfigInvalid({
				projectConfigPath,
				detail: `the mount name "${value.name}" is invalid; a name must start with a letter or digit and use only letters, digits, "-", and "_"`,
			});
		}
		return Ok(value);
	}
	if (Array.isArray(value)) {
		return ProjectConfigError.ProjectConfigInvalid({
			projectConfigPath,
			detail:
				'the default export is an array; export the mount directly, for example `export default fuji()`',
		});
	}
	return ProjectConfigError.ProjectConfigInvalid({
		projectConfigPath,
		detail:
			'the default export must be a Mount (a value with a string `name` and an `open` function)',
	});
}

function isMount(value: unknown): value is Mount {
	return (
		typeof value === 'object' &&
		value !== null &&
		'name' in value &&
		typeof (value as { name: unknown }).name === 'string' &&
		'open' in value &&
		typeof (value as { open: unknown }).open === 'function'
	);
}
