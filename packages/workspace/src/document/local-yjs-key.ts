const LOCAL_YJS_KEY_PREFIX = 'epicenter.v1.subject';

/**
 * Create the browser-local persistence and BroadcastChannel key for a Y.Doc.
 *
 * This key is a local runtime name only. It does not change `ydoc.guid`, sync
 * room names, child document GUIDs, or encryption workspace labels.
 */
export function createOwnedYjsKey(subject: string, ydocGuid: string): string {
	return `${LOCAL_YJS_KEY_PREFIX}.${subject}.yjs.${ydocGuid}`;
}
