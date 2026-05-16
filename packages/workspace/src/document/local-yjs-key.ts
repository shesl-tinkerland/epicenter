const LOCAL_YJS_KEY_PREFIX = 'epicenter.owner';

/**
 * Owner-scoped IndexedDB and BroadcastChannel prefix for the given owner.
 *
 * Every name returned by `createOwnedYjsKey(ownerId, _)` starts with this
 * string. Wipe paths use it to enumerate every database owned by `ownerId`.
 */
export function getOwnedYjsPrefix(ownerId: string): string {
	return `${LOCAL_YJS_KEY_PREFIX}.${ownerId}.yjs.`;
}

/**
 * Create the browser-local persistence and BroadcastChannel key for a Y.Doc.
 *
 * The `ownerId` argument scopes local data on shared browser profiles. Callers
 * usually pass `localIdentity.subject`; this helper names the value by its
 * local-storage role instead of its auth role.
 *
 * This key is a local runtime name only. It does not change `ydoc.guid`, sync
 * room names, child document GUIDs, or encryption workspace labels.
 */
export function createOwnedYjsKey(ownerId: string, ydocGuid: string): string {
	return `${getOwnedYjsPrefix(ownerId)}${ydocGuid}`;
}
