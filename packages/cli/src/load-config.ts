/**
 * Workspace daemon config loader.
 *
 * `loadDaemonConfig()` imports and validates `epicenter.config.ts` without
 * opening any daemon resources. `startDaemonRoutes()` is the only function in
 * this module that calls route `start()` hooks.
 */

import { join, resolve } from 'node:path';
import type { AuthClient } from '@epicenter/auth';
import { createMachineAuthClient } from '@epicenter/auth/node';
import type { ProjectDir } from '@epicenter/workspace';
import type {
	DaemonRouteDefinition,
	DaemonRuntime,
	StartedDaemonRoute,
} from '@epicenter/workspace/daemon';
import { validateDaemonRouteNames } from '@epicenter/workspace/node';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { Ok, type Result, tryAsync } from 'wellcrafted/result';

const log = createLogger('loadDaemonConfig');

export const CONFIG_FILENAME = 'epicenter.config.ts';

export type { DaemonRuntime, StartedDaemonRoute };

export type LoadedDaemonConfig = {
	projectDir: ProjectDir;
	configPath: string;
	routes: readonly DaemonRouteDefinition[];
};

export type StartDaemonRoutesOptions = {
	auth?: AuthClient;
};

export const DaemonConfigError = defineErrors({
	MissingFile: ({ configPath }: { configPath: string }) => ({
		message: `No ${CONFIG_FILENAME} found in ${configPath}`,
		configPath,
	}),
	ImportFailed: ({
		configPath,
		cause,
	}: {
		configPath: string;
		cause: unknown;
	}) => ({
		message: `failed to load ${configPath}: ${extractErrorMessage(cause)}`,
		configPath,
		cause,
	}),
	InvalidConfig: ({ configPath }: { configPath: string }) => ({
		message:
			`Invalid ${CONFIG_FILENAME} in ${configPath}: ` +
			`default export must be { daemon: { routes: [...] } }.`,
		configPath,
	}),
	EmptyConfig: ({ configPath }: { configPath: string }) => ({
		message:
			`No daemon routes found in ${configPath}.\n` +
			`Default-export { daemon: { routes: [...] } } with at least one route.`,
		configPath,
	}),
	InvalidRouteDefinition: ({
		configPath,
		route,
	}: {
		configPath: string;
		route: string;
	}) => ({
		message:
			`Invalid daemon route "${route}" in ${configPath}: ` +
			`expected a route definition with route and start.`,
		configPath,
		route,
	}),
	DuplicateRoute: ({
		configPath,
		route,
	}: {
		configPath: string;
		route: string;
	}) => ({
		message: `Duplicate daemon route "${route}" in ${configPath}.`,
		configPath,
		route,
	}),
	RouteFailed: ({
		configPath,
		route,
		cause,
	}: {
		configPath: string;
		route: string;
		cause: unknown;
	}) => ({
		message:
			`Failed to initialize daemon route "${route}" in ${configPath}: ` +
			extractErrorMessage(cause),
		configPath,
		route,
		cause,
	}),
	InvalidRouteRuntime: ({
		configPath,
		route,
	}: {
		configPath: string;
		route: string;
	}) => ({
		message:
			`Invalid daemon route "${route}" in ${configPath}: ` +
			`expected a daemon runtime with collaboration.peers, ` +
			`collaboration.onStatusChange, and [Symbol.asyncDispose].`,
		configPath,
		route,
	}),
	InvalidRoute: ({
		configPath,
		route,
	}: {
		configPath: string;
		route: string;
	}) => ({
		message:
			`Invalid daemon route "${route}" in ${configPath}: ` +
			`use letters, numbers, "_" or "-", and avoid reserved object keys.`,
		configPath,
		route,
	}),
});
export type DaemonConfigError = InferErrors<typeof DaemonConfigError>;

function hasDaemonRuntimeShape(value: unknown): value is DaemonRuntime {
	if (!isObjectRecord(value)) return false;
	const { collaboration } = value;
	if (!isObjectRecord(collaboration)) return false;
	const peers = collaboration.peers;
	if (!isObjectRecord(peers)) return false;
	return (
		typeof peers.list === 'function' &&
		typeof peers.observe === 'function' &&
		typeof collaboration.onStatusChange === 'function' &&
		typeof value[Symbol.asyncDispose] === 'function'
	);
}

function isObjectRecord(value: unknown): value is Record<PropertyKey, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function hasRouteDefinitionShape(
	value: unknown,
): value is DaemonRouteDefinition {
	return (
		isObjectRecord(value) &&
		typeof value.route === 'string' &&
		typeof value.start === 'function'
	);
}

export async function disposeStartedDaemonRoutes(
	runtimes: readonly StartedDaemonRoute[],
): Promise<void> {
	const results = await Promise.allSettled(
		runtimes.map((entry) => entry.runtime[Symbol.asyncDispose]()),
	);
	for (const [index, result] of results.entries()) {
		if (result.status === 'rejected') {
			const route = runtimes[index]?.route ?? '<unknown>';
			log.warn(
				new Error(`Daemon route "${route}" disposer rejected`, {
					cause: result.reason,
				}),
			);
		}
	}
}

/**
 * Load daemon route definitions from the explicit default project config.
 */
export async function loadDaemonConfig(
	targetDir: string,
): Promise<Result<LoadedDaemonConfig, DaemonConfigError>> {
	const projectDir = resolve(targetDir) as ProjectDir;
	const configPath = join(projectDir, CONFIG_FILENAME);

	if (!(await Bun.file(configPath).exists())) {
		return DaemonConfigError.MissingFile({ configPath });
	}

	const importResult = await tryAsync({
		try: () => import(Bun.pathToFileURL(configPath).href),
		catch: (cause) => DaemonConfigError.ImportFailed({ configPath, cause }),
	});
	if (importResult.error) return importResult;

	const config = (importResult.data as { default?: unknown }).default;
	if (
		!isObjectRecord(config) ||
		!isObjectRecord(config.daemon) ||
		!Array.isArray(config.daemon.routes)
	) {
		return DaemonConfigError.InvalidConfig({ configPath });
	}
	if (config.daemon.routes.length === 0) {
		return DaemonConfigError.EmptyConfig({ configPath });
	}

	const routes: DaemonRouteDefinition[] = [];
	for (const routeDefinition of config.daemon.routes) {
		const route = isObjectRecord(routeDefinition)
			? String(routeDefinition.route)
			: '<unknown>';
		if (!hasRouteDefinitionShape(routeDefinition)) {
			return DaemonConfigError.InvalidRouteDefinition({ configPath, route });
		}
		routes.push(routeDefinition);
	}

	const routeIssue = validateDaemonRouteNames(
		routes.map((entry) => entry.route),
	);
	if (routeIssue?.reason === 'invalid') {
		return DaemonConfigError.InvalidRoute({
			configPath,
			route: routeIssue.route,
		});
	}
	if (routeIssue?.reason === 'duplicate') {
		return DaemonConfigError.DuplicateRoute({
			configPath,
			route: routeIssue.route,
		});
	}

	return Ok({
		projectDir,
		configPath,
		routes,
	});
}

export async function startDaemonRoutes(
	config: LoadedDaemonConfig,
	options: StartDaemonRoutesOptions = {},
): Promise<Result<StartedDaemonRoute[], DaemonConfigError>> {
	const runtimes: StartedDaemonRoute[] = [];
	const auth = options.auth ?? (await createMachineAuthClient());
	const ownsAuth = options.auth === undefined;

	for (const definition of config.routes) {
		let runtime: unknown;
		try {
			runtime = await definition.start({
				auth,
				projectDir: config.projectDir,
				route: definition.route,
			});
		} catch (cause) {
			await disposeStartedDaemonRoutes(runtimes);
			if (ownsAuth) auth[Symbol.dispose]();
			return DaemonConfigError.RouteFailed({
				configPath: config.configPath,
				route: definition.route,
				cause,
			});
		}

		if (!hasDaemonRuntimeShape(runtime)) {
			await disposeStartedDaemonRoutes(runtimes);
			if (ownsAuth) auth[Symbol.dispose]();
			return DaemonConfigError.InvalidRouteRuntime({
				configPath: config.configPath,
				route: definition.route,
			});
		}

		runtimes.push({
			route: definition.route,
			runtime,
		});
	}

	return Ok(runtimes);
}
