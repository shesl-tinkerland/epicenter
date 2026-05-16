/**
 * Source of truth for route-qualified daemon action paths.
 *
 * `/list` publishes action keys in this format, and `/run` accepts the same
 * format from the CLI. Route validation rejects dots in route names, so the
 * first dot belongs to the route boundary. Everything after it is the
 * route-local action key. Valid action keys are snake_case, so additional dots
 * remain part of an invalid key and resolve as ActionNotFound.
 */
import {
	type ActionManifest,
	type ActionRegistry,
	toActionMeta,
} from '../shared/actions.js';

type RouteActionSource = {
	route: string;
	actions: ActionRegistry;
};

type ParsedDaemonActionPath = {
	routeName: string;
	localPath: string;
};

/**
 * Build the daemon-visible path for a route-local action.
 *
 * Use this anywhere daemon output names an action for humans or clients. That
 * keeps `/list` manifest keys and `/run` suggestion lines aligned on the same
 * route qualifier rule.
 */
export function joinDaemonActionPath(
	routeName: string,
	localPath: string,
): string {
	return localPath ? `${routeName}.${localPath}` : routeName;
}

/**
 * Split a daemon-visible action path into route and route-local pieces.
 *
 * This does not validate that the route exists. It only applies the wire
 * format: the first segment is the daemon route, and the rest is the action key
 * hosted by that route.
 */
export function parseDaemonActionPath(
	actionPath: string,
): ParsedDaemonActionPath {
	const [routeName = '', ...rest] = actionPath.split('.');
	return {
		routeName,
		localPath: rest.join('.'),
	};
}

/**
 * Project hosted route action registries into the flat `/list` manifest.
 *
 * The daemon keeps each route's registry local, but the CLI needs one manifest
 * keyed by the same paths that `/run` accepts. This is the production bridge
 * between those two views.
 */
export function createRouteActionManifest(
	routes: readonly RouteActionSource[],
): ActionManifest {
	const manifest: ActionManifest = {};
	for (const entry of routes) {
		for (const [path, action] of Object.entries(entry.actions)) {
			manifest[joinDaemonActionPath(entry.route, path)] = toActionMeta(action);
		}
	}
	return manifest;
}
