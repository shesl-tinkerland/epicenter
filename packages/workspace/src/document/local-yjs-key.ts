const LOCAL_YJS_KEY_PREFIX = 'epicenter.subject';

/**
 * Create the browser-local persistence and BroadcastChannel key for a Y.Doc.
 *
 * The `subject` argument is the auth identity label acting as the local owner
 * id. It scopes local data on shared browser profiles; it is not the Y.Doc
 * guid and it is not the sync room name.
 *
 * This key is a local runtime name only. It does not change `ydoc.guid`, sync
 * room names, child document GUIDs, or encryption workspace labels.
 */
export function createOwnedYjsKey(subject: string, ydocGuid: string): string {
	return `${LOCAL_YJS_KEY_PREFIX}.${subject}.yjs.${ydocGuid}`;
}
