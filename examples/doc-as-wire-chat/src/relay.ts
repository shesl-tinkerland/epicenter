/**
 * The RELAY (ADR-0024): a deliberately dumb, app-blind byte router.
 *
 * It holds one Y.Doc per room name and forwards opaque Yjs sync frames between
 * the peers connected to that room. It speaks the exact same wire protocol as
 * the production relay (`@epicenter/sync`: STEP1 / STEP2 / UPDATE) and never
 * decodes an application field: it sees a room name and a blob of bytes, nothing
 * more. That blindness is the whole point of the role split.
 *
 * In-memory only: the room state lives in this process, so a peer can disconnect
 * and reconnect and catch back up (durability of the relay-as-store), but
 * restarting the relay clears everything. Durable, restart-surviving storage is
 * the ANCHOR's job, a later slice.
 *
 * Run: `bun run src/relay.ts`
 */

import {
	encodeSyncStep1,
	encodeSyncUpdate,
	handleSyncPayload,
	type SyncMessageType,
} from '@epicenter/sync';
import type { ServerWebSocket } from 'bun';
import * as decoding from 'lib0/decoding';
import * as Y from 'yjs';

type WsData = { room: string };
type Socket = ServerWebSocket<WsData>;
type Room = { doc: Y.Doc; sockets: Set<Socket> };

const PORT = Number(process.env.PORT ?? 8787);
const rooms = new Map<string, Room>();

/** Get or lazily create a room. The fan-out listener is wired exactly once. */
function getRoom(name: string): Room {
	const existing = rooms.get(name);
	if (existing) return existing;

	const doc = new Y.Doc({ gc: true });
	const sockets = new Set<Socket>();
	// Fan every applied update out to all peers except the one that produced it.
	doc.on('updateV2', (update: Uint8Array, origin: unknown) => {
		const frame = encodeSyncUpdate({ update });
		for (const sock of sockets) {
			if (sock === origin) continue;
			sock.send(frame);
		}
	});
	const room: Room = { doc, sockets };
	rooms.set(name, room);
	return room;
}

Bun.serve<WsData>({
	port: PORT,
	fetch(req, server) {
		const room = new URL(req.url).pathname.replace(/^\/+/, '') || 'demo';
		if (server.upgrade(req, { data: { room } })) return;
		return new Response('doc-as-wire relay: connect over WebSocket\n', {
			status: 426,
		});
	},
	websocket: {
		open(ws) {
			const room = getRoom(ws.data.room);
			room.sockets.add(ws);
			// Kick the handshake: "here's my state vector, what are you missing?"
			ws.send(encodeSyncStep1({ doc: room.doc }));
			console.log(
				`+ peer joined room "${ws.data.room}" (${room.sockets.size} now)`,
			);
		},
		message(ws, message) {
			// Text frames (presence/dispatch) are unused in this demo.
			if (typeof message === 'string') return;

			const room = getRoom(ws.data.room);
			const bytes = message as unknown as Uint8Array;
			const decoder = decoding.createDecoder(bytes);
			const syncType = decoding.readVarUint(decoder) as SyncMessageType;
			const payload = decoding.readVarUint8Array(decoder);
			// The ONE thing the relay does: apply the frame to the room doc (which
			// fans it out) and answer a STEP1 with the diff. It reads no app field.
			const reply = handleSyncPayload({
				syncType,
				payload,
				doc: room.doc,
				origin: ws,
			});
			if (reply) ws.send(reply);
			console.log(
				`  fwd room="${ws.data.room}" ${bytes.byteLength}b (opaque bytes)`,
			);
		},
		close(ws) {
			const room = rooms.get(ws.data.room);
			room?.sockets.delete(ws);
			console.log(
				`- peer left room "${ws.data.room}" (${room?.sockets.size ?? 0} now)`,
			);
		},
	},
});

console.log(
	`relay listening :${PORT}  (in-memory rooms; app-blind byte router)`,
);
