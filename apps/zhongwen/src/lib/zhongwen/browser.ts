import {
	attachBroadcastChannel,
	attachIndexedDb,
} from '@epicenter/workspace';
import { openZhongwen as openZhongwenDoc } from './core';

export function openZhongwen() {
	const doc = openZhongwenDoc();
	const idb = attachIndexedDb(doc.ydoc);
	attachBroadcastChannel(doc.ydoc);
	return {
		...doc,
		idb,
		whenReady: idb.whenLoaded,
	};
}
