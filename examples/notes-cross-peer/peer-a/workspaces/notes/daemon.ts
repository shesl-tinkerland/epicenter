/**
 * Peer-A mount for the cross-peer sync repro. Uses a hard-coded
 * `deviceId` so peer-A is distinguishable from peer-B in the same
 * workspace.
 */

import { defineMount } from '@epicenter/workspace/daemon';
import { openNotes } from '../../../notes';

export default defineMount({
	name: 'notes',
	open: ({ ownerId, openWebSocket, onReconnectSignal }) =>
		openNotes({
			deviceId: 'notes-repro-peer-a',
			ownerId,
			openWebSocket,
			onReconnectSignal,
		}),
});
