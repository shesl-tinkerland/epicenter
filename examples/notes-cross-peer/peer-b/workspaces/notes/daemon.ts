/**
 * Peer-B mount for the cross-peer sync repro. Uses a hard-coded
 * `deviceId` so peer-B is distinguishable from peer-A in the same
 * workspace.
 */

import { defineMount } from '@epicenter/workspace/daemon';
import { openNotes } from '../../../notes';

export default defineMount({
	name: 'notes',
	open: ({ ownerId, openWebSocket, onReconnectSignal }) =>
		openNotes({
			deviceId: 'notes-repro-peer-b',
			ownerId,
			openWebSocket,
			onReconnectSignal,
		}),
});
