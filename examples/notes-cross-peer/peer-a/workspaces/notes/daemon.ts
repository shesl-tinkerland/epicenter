/**
 * Peer-A mount for the cross-peer sync repro. Threads its ctx `nodeId`
 * (resolved per Epicenter root) so peer-A is distinguishable from peer-B in
 * the same workspace.
 */

import { defineSessionMount } from '@epicenter/workspace/daemon';
import { openNotes } from '../../../notes';

export default defineSessionMount({
	name: 'notes',
	open: ({ session, nodeId }) =>
		openNotes({
			nodeId,
			ownerId: session.ownerId,
			openWebSocket: session.openWebSocket,
			onReconnectSignal: session.onReconnectSignal,
		}),
});
