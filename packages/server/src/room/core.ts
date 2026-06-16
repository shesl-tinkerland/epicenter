/**
 * Runtime-agnostic Yjs sync + dispatch room.
 *
 * Owns: the Yjs document, the connection set, server-owned presence, and
 * the dispatch correlation table. Does NOT own the WebSocket lifecycle
 * (fetch/upgrade/`webSocketMessage` callbacks), the alarm scheduling, or
 * the update-log storage; those are backend-specific and live in the
 * adapter.
 *
 * Imports no `cloudflare:workers` symbols. Both Cloudflare's Durable
 * Object and a future Bun backend drive the same {@link createRoomCore}
 * instance through the methods listed on its return object.
 *
 * ## Wire surfaces
 *
 * Two wire surfaces share one authenticated socket but are independent at
 * the protocol level:
 *
 *   binary WS frames  -> standard y-protocols SYNC.
 *   text WS frames    -> live-node dispatch and the server-owned
 *                        presence channel (`presence`).
 *
 * Dispatch is relay-mediated and rides text frames: a caller's
 * `dispatch_request` is routed to the recipient as `dispatch_inbound`;
 * the recipient's `dispatch_response` is routed back to the caller as
 * `dispatch_result`, correlated by a caller-minted `id`.
 *
 * ## Presence
 *
 * Presence is server-owned: the `connections` map is the source of truth.
 * On every connection change a `presence` text frame is broadcast carrying
 * the FULL client list (computed per-recipient, self excluded), so clients
 * store the list verbatim with no delta reassembly.
 *
 * ## Adapter contract
 *
 * Backends drive `RoomCore` through six entry points:
 *
 *   - `addConnection(socket, connection)`     on accept
 *   - `removeConnection(socket, code)`         on close
 *   - `handleMessage(socket, message)`         on inbound frame
 *   - `sync(body)` / `getDoc()`                for HTTP RPC
 *   - `compact()`                              after idle
 *
 * `connectionCount` is exposed as a query so the backend can schedule
 * deferred compaction when the room empties.
 */

import {
	decodeSyncRequest,
	encodeSyncStep1,
	encodeSyncUpdate,
	handleSyncPayload,
	type SyncMessageType,
	stateVectorsEqual,
} from '@epicenter/sync';
import {
	checkDispatchRequestFrame,
	checkDispatchResponseFrame,
	type DispatchErrorWire,
	type DispatchInboundFrame,
	type DispatchResultFrame,
} from '@epicenter/workspace/document/dispatch-protocol';
import {
	checkPresencePublishFrame,
	type Peer,
	type PresenceFrame,
} from '@epicenter/workspace/document/presence';
import * as decoding from 'lib0/decoding';
import { createLogger } from 'wellcrafted/logger';
import { Err, Ok, type Result, trySync } from 'wellcrafted/result';
import * as Y from 'yjs';
import { MAX_PAYLOAD_BYTES } from '../constants.js';
import type { Connection } from '../types.js';
import { RoomError, type RoomSocket, type RoomUpdateLog } from './contracts.js';

const log = createLogger('server/room/core');

// ============================================================================
// Constants
// ============================================================================

/**
 * Max compacted update size.
 *
 * Sized for the Cloudflare DO SQLite per-row BLOB limit (2 MB). Other
 * backends may technically exceed this, but the conservative cap keeps
 * cross-backend behavior identical and avoids surprises if a room
 * migrates between backends.
 */
const MAX_COMPACTED_BYTES = 2 * 1024 * 1024;

/**
 * Grace window before the debounced presence rebroadcast fires after the
 * last socket for a client closes.
 *
 * A graceful tab handoff (T1 closes, T2 connects within a few hundred ms)
 * would otherwise broadcast the client as gone and then back, even though
 * it was continuously present from the user's perspective. The debounce
 * lets a reconnecting socket supersede the pending rebroadcast before
 * peers ever see the flap.
 *
 * Close-code policy: WebSocket close code 4401 (permanent auth failure)
 * bypasses the debounce and rebroadcasts immediately. There is no
 * legitimate handoff for an auth-failed socket, and forcing peers to wait
 * 300 ms to learn a client is permanently offline yields no benefit.
 * All other close codes (1000, 1006, 1009, 1011, 4400, ...) respect the
 * window.
 */
const PRESENCE_REBROADCAST_GRACE_MS = 300;

/**
 * How long the relay holds an in-flight dispatch before answering the
 * caller with `RecipientOffline`. Bounds the `pendingDispatches` map for
 * long-lived sockets; not the caller's deadline. The caller's
 * `dispatch()` carries its own ceiling.
 */
const DISPATCH_INTERNAL_TIMEOUT_MS = 60_000;

/**
 * WebSocket close code emitted by the auth layer when the connection's
 * credentials are permanently invalid. Bypasses the presence grace window:
 * peers see the client drop immediately instead of waiting 300 ms for a
 * handoff that cannot happen.
 */
const CLOSE_CODE_AUTH_FAILED = 4401;

/** WebSocket-spec OPEN readyState. */
const WS_READY_OPEN = 1;

// ============================================================================
// Internal types
// ============================================================================

/**
 * In-flight dispatch routing entry. The relay holds one of these for each
 * dispatch awaiting a response: the caller socket the result returns to,
 * the recipient socket the call is waiting on, and the safety timeout
 * that answers `RecipientOffline` if the recipient never replies.
 */
type PendingDispatch = {
	callerWs: RoomSocket;
	recipientWs: RoomSocket;
	timeout: ReturnType<typeof setTimeout>;
};

// ============================================================================
// createRoomCore
// ============================================================================

/**
 * Build one runtime-agnostic room over a {@link RoomUpdateLog}.
 *
 * The factory eagerly:
 * 1. Creates a `Y.Doc({ gc: true })`.
 * 2. Replays every persisted update from `updateLog.loadAll()` into it.
 * 3. Opportunistically compacts the log on cold start.
 * 4. Subscribes to `updateV2` so every live update is persisted and
 *    fanned out to peer sockets (excluding the origin).
 *
 * Connections are added by the backend via {@link RoomCore.addConnection}.
 * The adapter remains responsible for the runtime-specific accept (the
 * Cloudflare hibernation API call or `Bun.serve` upgrade); this factory
 * handles every in-room consequence.
 *
 * @param deps - Injected dependencies.
 * @param deps.updateLog - Persistent update log for this room's doc.
 */
export function createRoomCore({ updateLog }: { updateLog: RoomUpdateLog }) {
	// ==========================================================================
	// State
	// ==========================================================================

	/** The shared Yjs document for this room. Always `gc: true`. */
	const doc = new Y.Doc({ gc: true });

	/** Open connections, mapped to their per-connection {@link Connection}. */
	const connections = new Map<RoomSocket, Connection>();

	/**
	 * Pending debounced presence rebroadcast, or `null` if none is armed.
	 * Armed when the last socket for a client closes; cleared by the
	 * timer firing (real disconnect) or by a connect superseding it
	 * (handoff).
	 */
	let pendingRebroadcast: ReturnType<typeof setTimeout> | null = null;

	/**
	 * In-flight dispatches awaiting `dispatch_response`, keyed by the
	 * caller-minted correlation id.
	 */
	const pendingDispatches = new Map<string, PendingDispatch>();

	// ==========================================================================
	// Init
	// ==========================================================================

	// Replay every persisted update, then opportunistically compact.
	for (const update of updateLog.loadAll()) {
		Y.applyUpdateV2(doc, update);
	}
	compactUpdateLog(doc, updateLog);

	// Persist every live update. Synchronous: the Yjs listener cannot await.
	doc.on('updateV2', (update: Uint8Array) => {
		updateLog.append(update);
	});

	// Fan every doc update out to all connected sockets except origin.
	// The frame is encoded once and `connections` is read at fire time,
	// so the broadcast always reflects the live socket set.
	doc.on('updateV2', (update: Uint8Array, origin: unknown) => {
		const frame = encodeSyncUpdate({ update });
		for (const ws of connections.keys()) {
			if (ws === origin) continue;
			try {
				ws.send(frame);
			} catch {
				/* dead socket; its close event runs cleanup */
			}
		}
	});

	// ==========================================================================
	// Presence helpers
	// ==========================================================================

	/**
	 * Deduped snapshot of currently-connected peers, newest-wins per
	 * `nodeId`. Pass `exclude` to omit the caller's own socket; if the
	 * caller's node still has other open sockets (multi-tab same-node
	 * edge case), those siblings are excluded too. The result is the
	 * "peers" from the perspective of the receiver, sorted by
	 * `nodeId` for deterministic output.
	 */
	function snapshotPeers(exclude?: RoomSocket): Peer[] {
		const excludeNode = exclude ? connections.get(exclude)?.nodeId : undefined;
		const seen = new Map<string, Peer>();
		for (const [ws, attachment] of connections) {
			if (ws === exclude) continue;
			if (excludeNode && attachment.nodeId === excludeNode) {
				continue;
			}
			const existing = seen.get(attachment.nodeId);
			if (existing && existing.connectedAt >= attachment.connectedAt) continue;
			seen.set(attachment.nodeId, {
				nodeId: attachment.nodeId,
				connectedAt: attachment.connectedAt,
				actions: attachment.actions,
			});
		}
		return Array.from(seen.values()).sort((a, b) =>
			a.nodeId.localeCompare(b.nodeId),
		);
	}

	/**
	 * Count OPEN sockets currently associated with `nodeId`. Used to
	 * detect the first socket for a node (on connect) and the last (on
	 * close): the two events that change room membership.
	 */
	function countNodeSockets(nodeId: string): number {
		let count = 0;
		for (const [, data] of connections) {
			if (data.nodeId === nodeId) count++;
		}
		return count;
	}

	/**
	 * Push the current presence list to every open socket, optionally
	 * skipping `exclude` (a freshly-upgraded socket that was already sent
	 * its list directly). A wedged socket's `send` is swallowed; its
	 * close event runs the full cleanup path.
	 */
	function broadcastPresence(exclude?: RoomSocket): void {
		for (const [peer] of connections) {
			if (peer === exclude) continue;
			if (peer.readyState !== WS_READY_OPEN) continue;
			try {
				peer.send(
					JSON.stringify({
						type: 'presence',
						peers: snapshotPeers(peer),
					} satisfies PresenceFrame),
				);
			} catch {
				/* close cleanup handles the entry */
			}
		}
	}

	/**
	 * Arm the debounced presence rebroadcast after the grace window.
	 * Called when the last socket for a client closes. A single shared
	 * timer: if one is already pending, leave it, so a burst of departures
	 * is announced at most one grace window after the FIRST departure.
	 * When it fires it broadcasts the then-current full list, reflecting
	 * every departure (and any reconnect) that happened during the window.
	 */
	function schedulePresenceRebroadcast(): void {
		if (pendingRebroadcast) return;
		pendingRebroadcast = setTimeout(() => {
			pendingRebroadcast = null;
			broadcastPresence();
		}, PRESENCE_REBROADCAST_GRACE_MS);
	}

	/**
	 * Cancel a pending debounced rebroadcast. Called on connect: the
	 * connect path broadcasts the live list immediately, which supersedes
	 * whatever the debounced timer would have sent. A graceful tab handoff
	 * lands here (T1 closes and arms the timer, T2 connects and cancels
	 * it), so peers never observe the client leave.
	 */
	function cancelPendingRebroadcast(): void {
		if (!pendingRebroadcast) return;
		clearTimeout(pendingRebroadcast);
		pendingRebroadcast = null;
	}

	/**
	 * Resolve a recipient `nodeId` to the most-recently-connected open
	 * socket, if any. `Map` iteration is insertion order, so the LAST
	 * matching socket in a forward scan is the newest.
	 */
	function pickRecipient(nodeId: string): RoomSocket | null {
		let newest: RoomSocket | null = null;
		for (const [ws, data] of connections) {
			if (data.nodeId === nodeId && ws.readyState === WS_READY_OPEN) {
				newest = ws;
			}
		}
		return newest;
	}

	// ==========================================================================
	// Dispatch helpers
	// ==========================================================================

	/**
	 * Caller -> relay: start a dispatch. Picks the most-recently-connected
	 * socket for `to`, pushes `dispatch_inbound` to it, and records the
	 * pending entry so the recipient's `dispatch_response` can be routed
	 * back to `callerWs`. A malformed frame is dropped silently: the
	 * caller's own ceiling settles it.
	 */
	function handleDispatchRequest(callerWs: RoomSocket, frame: unknown): void {
		if (!checkDispatchRequestFrame.Check(frame)) return;
		const { id, to, action, input } = frame;

		const recipientWs = pickRecipient(to);
		if (!recipientWs) {
			sendDispatchResult(callerWs, id, recipientOffline(to));
			return;
		}

		const timeout = setTimeout(() => {
			const pending = pendingDispatches.get(id);
			if (!pending) return;
			pendingDispatches.delete(id);
			sendDispatchResult(pending.callerWs, id, recipientOffline(to));
		}, DISPATCH_INTERNAL_TIMEOUT_MS);

		pendingDispatches.set(id, { callerWs, recipientWs, timeout });

		try {
			recipientWs.send(
				JSON.stringify({
					type: 'dispatch_inbound',
					id,
					action,
					input,
				} satisfies DispatchInboundFrame),
			);
		} catch {
			// Recipient socket died between pickRecipient and send.
			clearTimeout(timeout);
			pendingDispatches.delete(id);
			sendDispatchResult(callerWs, id, recipientOffline(to));
		}
	}

	/**
	 * Recipient -> relay: an action outcome. Routes the result back to the
	 * caller that started the dispatch. A `dispatch_response` with no
	 * matching pending entry is a late reply (the caller already gave up,
	 * or the entry was lost to hibernation) and is dropped.
	 *
	 * Only the socket the dispatch was actually sent to may answer it. In a
	 * shared room a different member's socket cannot forge a result for a
	 * dispatch id it does not own, even if it learns the id. The id is unicast
	 * to the recipient, so this is defense in depth, not the only barrier.
	 *
	 * The TypeBox validator guarantees `frame.result` is a well-formed
	 * `Result<unknown, ActionResponseError>`. The relay still forwards the
	 * error side opaquely; the caller's own validator narrows it again to
	 * `DispatchErrorWire` (which adds `RecipientOffline` to the union).
	 */
	function handleDispatchResponse(
		responderWs: RoomSocket,
		frame: unknown,
	): void {
		if (!checkDispatchResponseFrame.Check(frame)) return;

		const pending = pendingDispatches.get(frame.id);
		if (!pending) return;
		if (pending.recipientWs !== responderWs) return;

		clearTimeout(pending.timeout);
		pendingDispatches.delete(frame.id);

		sendDispatchResult(pending.callerWs, frame.id, frame.result);
	}

	/**
	 * Send a `dispatch_result` frame to the caller socket. A dead caller
	 * socket is swallowed: its close event already ran (or will run) the
	 * pending-entry cleanup.
	 */
	function sendDispatchResult(
		callerWs: RoomSocket,
		id: string,
		result: Result<unknown, unknown>,
	): void {
		try {
			callerWs.send(
				JSON.stringify({
					type: 'dispatch_result',
					id,
					result,
				} satisfies DispatchResultFrame),
			);
		} catch {
			/* caller socket already dead; close cleanup handles the entry */
		}
	}

	/**
	 * Node -> relay: publish this socket's action manifest. The relay stores
	 * the manifest against the connection attachment, persists it via
	 * `serializeAttachment` when the runtime supports hibernation, and
	 * rebroadcasts presence so peers see the update. A malformed payload is
	 * dropped silently: the relay never trusts client input but never tears
	 * down a sync socket for one bad manifest publish either.
	 */
	function handlePresencePublish(socket: RoomSocket, frame: unknown): void {
		if (!checkPresencePublishFrame.Check(frame)) return;
		const existing = connections.get(socket);
		if (!existing) return;
		const updated: Connection = { ...existing, actions: frame.actions };
		connections.set(socket, updated);
		socket.serializeAttachment?.(updated);
		broadcastPresence();
	}

	/**
	 * Route a client -> relay text frame. Recognized types are `dispatch_request`,
	 * `dispatch_response`, and `presence_publish`. The TypeBox-compiled validator
	 * inside each handler narrows the frame; this dispatcher only owns the
	 * `type` switch and the protocol-error close path.
	 *
	 * Unparseable JSON or an unknown frame type is a genuine protocol desync and
	 * closes the socket with `4400 protocol-error`. A recognized frame with
	 * malformed fields is dropped without closing, because one bad text frame
	 * must not tear down sync and presence.
	 */
	function handleTextFrame(ws: RoomSocket, message: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(message);
		} catch {
			ws.close(4400, 'protocol-error');
			return;
		}

		const type =
			parsed && typeof parsed === 'object' && 'type' in parsed
				? (parsed as { type: unknown }).type
				: undefined;

		switch (type) {
			case 'dispatch_request':
				handleDispatchRequest(ws, parsed);
				return;
			case 'dispatch_response':
				handleDispatchResponse(ws, parsed);
				return;
			case 'presence_publish':
				handlePresencePublish(ws, parsed);
				return;
			default:
				ws.close(4400, 'protocol-error');
		}
	}

	// ==========================================================================
	// Public API
	// ==========================================================================

	return {
		/**
		 * Register a newly-accepted socket and run the connect-time
		 * presence flow.
		 *
		 * Sends the new socket its initial Yjs `SyncStep1` and a peer
		 * snapshot (the receiver's "peers"). If this is the FIRST
		 * socket for `nodeId`, room membership changed, so peers are
		 * rebroadcast the live list. Subsequent tabs of the same node
		 * leave the list unchanged and need no rebroadcast.
		 *
		 * A connect supersedes any pending debounced rebroadcast (the
		 * graceful tab handoff case).
		 *
		 * @param socket - The accepted WebSocket. The backend is
		 *   responsible for the runtime-specific accept (hibernation API
		 *   or `Bun.serve` upgrade) before calling this.
		 * @param connection - The connection attachment URL-stamped at
		 *   upgrade. `nodeId` is the dispatch address; `userId`
		 *   is the auth principal; `connectedAt` and `actions` are mirrored
		 *   on the wire so receivers can render node affordances.
		 */
		addConnection(socket: RoomSocket, connection: Connection): void {
			connections.set(socket, connection);

			socket.send(encodeSyncStep1({ doc }));
			socket.send(
				JSON.stringify({
					type: 'presence',
					peers: snapshotPeers(socket),
				} satisfies PresenceFrame),
			);

			if (countNodeSockets(connection.nodeId) === 1) {
				cancelPendingRebroadcast();
				broadcastPresence(socket);
			}
		},

		/**
		 * Drop a closed socket and run the disconnect-time flow.
		 *
		 * - Fails every in-flight dispatch touching this socket: a closed
		 *   recipient answers the caller `RecipientOffline`; a closed
		 *   caller just drops the entry (nobody to answer).
		 * - Removes the socket from `connections`.
		 * - If this was the LAST socket for the client, schedules the
		 *   debounced presence rebroadcast (or fires it immediately on
		 *   close code 4401, permanent auth failure).
		 *
		 * The backend is responsible for any runtime-specific close
		 * cleanup (hibernation defensive `ws.close`, alarm scheduling)
		 * after this call.
		 */
		removeConnection(socket: RoomSocket, code: number): void {
			const data = connections.get(socket);
			if (!data) return;

			for (const [id, pending] of pendingDispatches) {
				if (pending.recipientWs === socket) {
					clearTimeout(pending.timeout);
					pendingDispatches.delete(id);
					sendDispatchResult(
						pending.callerWs,
						id,
						recipientOffline(data.nodeId),
					);
				} else if (pending.callerWs === socket) {
					clearTimeout(pending.timeout);
					pendingDispatches.delete(id);
				}
			}

			connections.delete(socket);

			if (countNodeSockets(data.nodeId) === 0) {
				if (code === CLOSE_CODE_AUTH_FAILED) {
					cancelPendingRebroadcast();
					broadcastPresence();
				} else {
					schedulePresenceRebroadcast();
				}
			}
		},

		/**
		 * Handle one inbound WebSocket message.
		 *
		 * Routes on the message envelope:
		 * - text frames: dispatch correlation (`dispatch_request`,
		 *   `dispatch_response`) and other client text frames.
		 * - binary frames: standard y-protocols SYNC.
		 *
		 * Oversized messages close the socket with `1009 Message too
		 * large`. A `MessageDecode` failure is logged and dropped without
		 * closing the socket.
		 */
		handleMessage(socket: RoomSocket, message: ArrayBuffer | string): void {
			const data = connections.get(socket);
			if (!data) return;

			const byteLength =
				message instanceof ArrayBuffer ? message.byteLength : message.length;
			if (byteLength > MAX_PAYLOAD_BYTES) {
				socket.close(1009, 'Message too large');
				return;
			}

			if (typeof message === 'string') {
				handleTextFrame(socket, message);
				return;
			}

			const { data: reply, error } = trySync({
				try: () => {
					const decoder = decoding.createDecoder(new Uint8Array(message));
					const syncType = decoding.readVarUint(decoder) as SyncMessageType;
					const payload = decoding.readVarUint8Array(decoder);
					const response = handleSyncPayload({
						syncType,
						payload,
						doc,
						origin: socket,
					});
					return response ?? null;
				},
				catch: (cause) => RoomError.MessageDecode({ cause }),
			});
			if (error) {
				log.warn(error);
				return;
			}
			if (reply) socket.send(reply);
		},

		/**
		 * HTTP sync RPC.
		 *
		 * Binary body format:
		 * `[length-prefixed stateVector][length-prefixed update]`
		 * (encoded via `encodeSyncRequest` from `@epicenter/sync`).
		 *
		 * Applies the client update to the live doc and returns the
		 * binary diff the client is missing (or `null` if already in
		 * sync) wrapped in `Ok`. Returns `Err(MalformedSyncBody)` when
		 * the untrusted body fails to decode so the route can answer 400
		 * instead of 500.
		 */
		sync(body: Uint8Array) {
			const { data: clientSV, error } = trySync({
				try: () => {
					const { stateVector, update } = decodeSyncRequest(body);
					if (update.byteLength > 0) {
						Y.applyUpdateV2(doc, update, 'http');
					}
					return stateVector;
				},
				catch: (cause) => RoomError.MalformedSyncBody({ cause }),
			});
			if (error) return Err(error);

			const serverSV = Y.encodeStateVector(doc);
			const diff = stateVectorsEqual(serverSV, clientSV)
				? null
				: Y.encodeStateAsUpdateV2(doc, clientSV);

			return Ok({
				diff,
				storageBytes: updateLog.byteSize(),
			});
		},

		/**
		 * Snapshot bootstrap.
		 *
		 * Returns the full doc state via `Y.encodeStateAsUpdateV2`.
		 * Clients apply this with `Y.applyUpdateV2` to hydrate their
		 * local doc before opening a WebSocket, reducing the initial
		 * sync payload.
		 */
		getDoc(): { data: Uint8Array; storageBytes: number } {
			return {
				data: Y.encodeStateAsUpdateV2(doc),
				storageBytes: updateLog.byteSize(),
			};
		},

		/**
		 * Compact the update log into a single row.
		 *
		 * Backends call this when the room has been idle long enough
		 * (typically 30 s after the last connection closes). The compact
		 * itself is opportunistic: no-ops if the log has <= 1 entry or
		 * the encoded state exceeds the per-row blob cap.
		 */
		compact(): void {
			compactUpdateLog(doc, updateLog);
		},

		/**
		 * Open-connection count. Backends use this to decide whether to
		 * schedule deferred compaction after a `removeConnection` call.
		 */
		get connectionCount(): number {
			return connections.size;
		},
	};
}

/** Public shape of {@link createRoomCore}. Derived; do not hand-declare. */
export type RoomCore = ReturnType<typeof createRoomCore>;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Compact the update log into a single row.
 *
 * `Y.encodeStateAsUpdateV2` produces smaller output than
 * `Y.mergeUpdatesV2` because deleted items become lightweight GC structs
 * (with `gc: true`) and struct merging is more thorough. It also avoids
 * the exponential performance edge case documented in yjs#710.
 *
 * No-ops if the log already has <= 1 entry or the compacted blob exceeds
 * {@link MAX_COMPACTED_BYTES}. The cap is a Cloudflare DO SQLite
 * constraint kept as a shared invariant so cross-backend behavior is
 * identical.
 *
 * @see {@link https://github.com/yjs/yjs/issues/710 | yjs#710}
 */
function compactUpdateLog(doc: Y.Doc, updateLog: RoomUpdateLog): void {
	const count = updateLog.entryCount();
	if (count <= 1) return;

	const compacted = Y.encodeStateAsUpdateV2(doc);
	if (compacted.byteLength > MAX_COMPACTED_BYTES) return;

	updateLog.replaceAll(compacted);

	log.info('update log compacted', {
		entries: count,
		compactedBytes: compacted.byteLength,
	});
}

/**
 * The relay's one self-produced dispatch outcome: the recipient has no
 * usable socket (never connected, dropped mid-flight, timed out, or sent
 * a non-`Result` reply).
 *
 * Shaped as `Err` so the wire body is always a `Result`. The return type
 * is pinned to the wire contract's `RecipientOffline` variant, so a field
 * added there fails to compile here.
 */
function recipientOffline(
	to: string,
): Result<unknown, Extract<DispatchErrorWire, { name: 'RecipientOffline' }>> {
	return Err({ name: 'RecipientOffline', to });
}
