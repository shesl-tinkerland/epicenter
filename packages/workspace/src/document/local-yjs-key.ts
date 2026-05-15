// Durable browser-local prefix. Kept stable across the user -> subject
// rename so existing IndexedDB databases remain readable; the public
// argument name moved from `userId` to `subject` while the stored label
// did not change.
const LOCAL_YJS_KEY_PREFIX = 'epicenter.v1.user';

/**
 * Create the browser-local persistence and BroadcastChannel key for a Y.Doc.
 *
 * This key is a local runtime name only. It does not change `ydoc.guid`, sync
 * room names, child document GUIDs, or encryption workspace labels.
 */
export function createOwnedYjsKey(subject: string, ydocGuid: string): string {
	return `${LOCAL_YJS_KEY_PREFIX}.${subject}.yjs.${ydocGuid}`;
}
