/**
 * The peer-side sync glue: bind a local Y.Doc to the relay over a WebSocket.
 *
 * This is the minimal version of the transport adapter the cloudless spec
 * describes (the seam an Iroh sidecar would slot under). It speaks the same
 * `@epicenter/sync` protocol as the production client: send STEP1 on open,
 * answer inbound frames with `handleSyncPayload`, and push every local edit as
 * an UPDATE. Both the worker and the client are just peers; this is all either
 * of them needs to reach the wire.
 */

import {
	encodeSyncStep1,
	encodeSyncUpdate,
	handleSyncPayload,
	type SyncMessageType,
} from '@epicenter/sync';
import * as decoding from 'lib0/decoding';
import type * as Y from 'yjs';

/** Connect `doc` to the relay room at `url` as a sync peer. Returns the socket. */
export function connectPeer({
	url,
	doc,
	onStatus,
}: {
	url: string;
	doc: Y.Doc;
	onStatus?: (status: string) => void;
}): WebSocket {
	const ws = new WebSocket(url);
	ws.binaryType = 'arraybuffer';

	ws.addEventListener('open', () => {
		// Ask the relay for anything we're missing; it answers with a STEP2 diff.
		ws.send(encodeSyncStep1({ doc }));
		onStatus?.('connected');
	});

	ws.addEventListener('message', (event) => {
		if (typeof event.data === 'string') return; // presence/text: unused here
		const bytes = new Uint8Array(event.data as ArrayBuffer);
		const decoder = decoding.createDecoder(bytes);
		const syncType = decoding.readVarUint(decoder) as SyncMessageType;
		const payload = decoding.readVarUint8Array(decoder);
		const reply = handleSyncPayload({ syncType, payload, doc, origin: ws });
		if (reply) ws.send(reply);
	});

	// Push every LOCAL edit to the relay. Edits we applied FROM the relay carry
	// `origin === ws`, so we skip them and never echo an update back.
	doc.on('updateV2', (update: Uint8Array, origin: unknown) => {
		if (origin === ws) return;
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(encodeSyncUpdate({ update }));
		}
	});

	ws.addEventListener('close', () => onStatus?.('disconnected'));
	return ws;
}
