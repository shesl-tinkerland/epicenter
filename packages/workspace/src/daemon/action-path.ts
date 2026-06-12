/**
 * Source of truth for mount-prefixed daemon action paths.
 *
 * `/list` publishes action keys in this format, and `/run`
 * accepts the same format from clients. Mount validation rejects dots in mount
 * names, so the first dot belongs to the mount boundary. Everything after it
 * is the mount-local action key. Valid action keys are snake_case, so
 * additional dots remain part of an invalid key and resolve as ActionNotFound.
 */
type ParsedDaemonActionPath = {
	mount: string;
	localPath: string;
};

/**
 * Build the daemon-visible path for a mount-local action.
 *
 * Use this anywhere daemon output names an action for humans or clients. That
 * keeps `/list` manifest keys and action suggestion lines aligned on the same
 * mount qualifier rule.
 */
export function joinDaemonActionPath(mount: string, localPath: string): string {
	return localPath ? `${mount}.${localPath}` : mount;
}

/**
 * Split a daemon-visible action path into mount and mount-local pieces.
 *
 * This does not validate that the mount exists. It only applies the wire
 * format: the first segment is the mount name, and the rest is the action key
 * hosted by that mount.
 */
export function parseDaemonActionPath(
	actionPath: string,
): ParsedDaemonActionPath {
	const [mount = '', ...rest] = actionPath.split('.');
	return {
		mount,
		localPath: rest.join('.'),
	};
}
