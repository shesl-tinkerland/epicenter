/**
 * Load a project's `epicenter.config.ts` and return its mounts.
 *
 * The config default-exports one of:
 *
 *   - a single `Mount` (the common case):
 *       `export default fuji();`
 *
 *   - a `Mount[]` for multi-mount projects:
 *       `export default [fuji(), notes()];`
 *
 * Mount detection is duck-typed: a value is a Mount iff it has a string `name`
 * and a function `open`. There is no wrapper helper (no `defineProject`); the
 * mount factory IS the config. The loader returns a normalized `Mount[]` so
 * callers don't branch on shape.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

import type { Mount } from '../daemon/define-mount.js';
import type { ProjectDir } from '../shared/types.js';
import {
	DEFAULT_PROJECT_CONFIG_SOURCE,
	PROJECT_CONFIG_FILENAME,
} from './project-config-source.js';

export const ProjectConfigError = defineErrors({
	ProjectConfigNotFound: ({
		projectConfigPath,
	}: {
		projectConfigPath: string;
	}) => ({
		message: `Project config not found at ${projectConfigPath}`,
		projectConfigPath,
	}),
});
export type ProjectConfigError = InferErrors<typeof ProjectConfigError>;

export async function loadProjectConfig(
	projectDir: ProjectDir | string,
): Promise<Result<Mount[], ProjectConfigError>> {
	const projectConfigPath = join(resolve(projectDir), PROJECT_CONFIG_FILENAME);
	if (!existsSync(projectConfigPath)) {
		return ProjectConfigError.ProjectConfigNotFound({ projectConfigPath });
	}

	const module = await importProjectConfig(projectConfigPath);
	if (!('default' in module)) {
		throw new Error(
			`loadProjectConfig: ${projectConfigPath} must default-export a Mount or Mount[].`,
		);
	}

	const fail = (reason: string): never => {
		throw new Error(`loadProjectConfig: ${projectConfigPath} ${reason}`);
	};

	const value = module.default;
	if (Array.isArray(value)) {
		for (const entry of value) {
			if (!isMount(entry)) {
				fail('default-exports an array containing a non-Mount value.');
			}
		}
		return Ok(value as Mount[]);
	}
	if (isMount(value)) {
		return Ok([value]);
	}
	return fail('must default-export a Mount or Mount[].');
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

async function importProjectConfig(
	projectConfigPath: string,
): Promise<{ default?: unknown }> {
	try {
		return (await import(pathToFileURL(projectConfigPath).href)) as {
			default?: unknown;
		};
	} catch (cause) {
		if (isDefaultConfigSelfImportMiss(projectConfigPath, cause)) {
			return { default: [] };
		}
		throw new Error(
			`loadProjectConfig: failed to load ${projectConfigPath}: ${extractErrorMessage(cause)}`,
			{ cause },
		);
	}
}

function isDefaultConfigSelfImportMiss(
	projectConfigPath: string,
	cause: unknown,
): boolean {
	return (
		extractErrorMessage(cause).includes(
			"Cannot find module '@epicenter/workspace'",
		) &&
		readFileSync(projectConfigPath, 'utf8') === DEFAULT_PROJECT_CONFIG_SOURCE
	);
}
