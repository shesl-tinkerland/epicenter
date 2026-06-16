/**
 * Peer-B mount for the cross-peer sync repro. Threads its ctx `nodeId`
 * (resolved per Epicenter root) so peer-B is distinguishable from peer-A in
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
