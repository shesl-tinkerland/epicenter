// Mount names are config-supplied identifiers (or carried by the Mount itself).
// They become the prefix of `/list` manifest keys and `/run` action paths
// (`${mount}.${action}`), so they must exclude `.` (the mount boundary) and
// start with an alphanumeric. The leading-character class also rejects
// `__proto__` and other underscore-led names.
const MOUNT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export type MountNameIssue = {
	mount: string;
	reason: 'invalid' | 'duplicate';
};

export function validateMountNames(
	mounts: readonly string[],
): MountNameIssue | null {
	const seen = new Set<string>();
	for (const mount of mounts) {
		if (seen.has(mount)) return { mount, reason: 'duplicate' };
		seen.add(mount);
	}
	for (const mount of mounts) {
		if (!MOUNT_NAME_PATTERN.test(mount)) {
			return { mount, reason: 'invalid' };
		}
	}
	return null;
}
