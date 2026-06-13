// Mount names are config-supplied identifiers (or carried by the Mount itself).
// They become the prefix of `/list` manifest keys and daemon action paths
// (`${mount}.${action}`), so they must exclude `.` (the mount boundary) and
// start with an alphanumeric. The leading-character class also rejects
// `__proto__` and other underscore-led names.
const MOUNT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * The single home for the mount-name format rule. The loader checks it per
 * config (the earliest point, with a file-pointed error); `validateMountNames`
 * reuses it when validating the daemon's whole served set.
 */
export function isValidMountName(name: string): boolean {
	return MOUNT_NAME_PATTERN.test(name);
}

export type MountNameIssue = {
	mount: string;
	reason: 'invalid' | 'duplicate';
};

/**
 * Validate the daemon's served set: every name well-formed, no two the same.
 * Duplicate detection is the part that can only happen here, once the set is
 * assembled (one config can never collide with itself).
 */
export function validateMountNames(
	mounts: readonly string[],
): MountNameIssue | null {
	const seen = new Set<string>();
	for (const mount of mounts) {
		if (seen.has(mount)) return { mount, reason: 'duplicate' };
		seen.add(mount);
	}
	for (const mount of mounts) {
		if (!isValidMountName(mount)) {
			return { mount, reason: 'invalid' };
		}
	}
	return null;
}
