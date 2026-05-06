/** `recordingsFs` is a no-op in non-Tauri environments. */

import { attachBroadcastChannel, attachIndexedDb } from '@epicenter/workspace';
import { PATHS } from '$lib/constants/paths';
import { attachRecordingMarkdownFiles } from '$lib/recording-materializer';
import { openWhispering as openWhisperingDoc } from './index';

export function openWhispering() {
	const doc = openWhisperingDoc();

	const idb = attachIndexedDb(doc.ydoc);
	attachBroadcastChannel(doc.ydoc);

	const recordingsFs = attachRecordingMarkdownFiles(
		doc.ydoc,
		doc.tables.recordings,
		{
			dir: PATHS.DB.RECORDINGS(),
			waitFor: idb.whenLoaded,
		},
	);

	return {
		...doc,
		idb,
		recordingsFs,
		whenReady: Promise.all([idb.whenLoaded, recordingsFs.whenFlushed]),
	};
}
