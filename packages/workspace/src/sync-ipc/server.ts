/**
 * Daemon-side, per-Y.Doc IPC sync server.
 *
 * `attachIpcSyncServer(ydoc, opts)` wires one Y.Doc to peer sessions arriving
 * over the unix socket. It does NOT bind the socket: it exposes
 * `acceptSession({ channel, preamble })`, which the socket-bind layer
 * (`./listener.ts`) calls once it has parsed the JSON preamble and resolved
 * the workspace selector. This separation keeps the server testable with an
 * in-memory channel pair and lets the listener multiplex N workspaces over
 * one socket.
 *
 * Wire vocabulary on the IPC socket is `MESSAGE_TYPE.SYNC` and
 * `MESSAGE_TYPE.AWARENESS` only. `SYNC_STATUS` and `RPC` are deliberately
 * absent (no flush primitive, no IPC mailbox); cross-device peer<T> RPC
 * stays on cloud sync.
 *
 * Per-session origin symbols (`Symbol(`hub:${sessionId}`)`) are load-bearing:
 * each session's outbound listener filters its own origin so a write from
 * peer A is broadcast to peers B and C without echoing back to A.
 *
 * Reconnect dedup: the same `clientId` reconnecting kicks the prior session
 * before announcing the new one. Without this, a flapping peer leaks
 * awareness state and a state-vector entry per reconnect.
 */

import * as decoding from 'lib0/decoding';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import {
	Awareness as YAwareness,
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
	removeAwarenessStates,
} from 'y-protocols/awareness';
import * as Y from 'yjs';

import {
	MESSAGE_TYPE,
	encodeAwareness,
	encodeAwarenessStates,
	encodeSyncStep1,
	encodeSyncUpdate,
	handleSyncPayload,
	type SyncMessageType,
} from '@epicenter/sync';

import type { IpcChannel, IpcPreamble } from './types.js';

// ============================================================================
// Types
// ============================================================================

/** Public snapshot of one connected session. */
export type SessionSnapshot = {
	sessionId: string;
	clientId: number;
	deviceId: string;
	isEphemeral: boolean;
	connectedAt: number;
};

/** Errors surfaced by the hub's background lifecycle. */
export const IpcSyncServerError = defineErrors({
	/** Inbound frame failed to decode or apply. */
	FrameHandlingFailed: ({
		sessionId,
		cause,
	}: {
		sessionId: string;
		cause: unknown;
	}) => ({
		message: `[attachIpcSyncServer] session ${sessionId}: ${extractErrorMessage(cause)}`,
		sessionId,
		cause,
	}),
});
export type IpcSyncServerError = InferErrors<typeof IpcSyncServerError>;

export type IpcSyncServer = {
	/** Workspace selector this server answers to. */
	readonly workspace: string;
	/**
	 * Take ownership of an already-handshook channel and run the sync state
	 * machine against `ydoc`. Resolves when the session ends (either side
	 * closes the channel). Never throws: errors flow to `opts.log`.
	 */
	acceptSession(args: {
		channel: IpcChannel;
		preamble: IpcPreamble;
	}): Promise<void>;
	/** Live snapshot of connected sessions. */
	peers(): SessionSnapshot[];
	/**
	 * Close all active sessions and detach Y.Doc listeners. Idempotent.
	 * Awaits each session's teardown so callers can reason about clean exit.
	 */
	close(): Promise<void>;
	/** Resolves after `close()` has fully settled. */
	whenDisposed: Promise<void>;
};

// ============================================================================
// Implementation
// ============================================================================

type SessionState = {
	id: string;
	origin: symbol;
	clientId: number;
	deviceId: string;
	isEphemeral: boolean;
	connectedAt: number;
	channel: IpcChannel;
	cleanup: () => void;
	whenClosed: Promise<void>;
	resolveClosed: () => void;
};

let sessionSeq = 0;
function nextSessionId(workspace: string): string {
	sessionSeq += 1;
	return `${workspace}:${sessionSeq}`;
}

export function attachIpcSyncServer(
	ydoc: Y.Doc,
	opts: {
		/** Workspace selector this server answers to. */
		workspace: string;
		/**
		 * Optional Awareness instance carried over the wire alongside the doc.
		 * When provided, peer awareness updates are applied to this instance
		 * and local awareness changes are forwarded to all sessions (filtered
		 * by per-session origin). Disconnects automatically remove the
		 * session's awareness state via `removeAwarenessStates`.
		 */
		awareness?: YAwareness;
		log?: Logger;
	},
): IpcSyncServer {
	const log = opts.log ?? createLogger('attachIpcSyncServer');
	const sessions = new Map<string, SessionState>();
	const sessionsByClientId = new Map<number, SessionState>();
	let isClosed = false;
	const { promise: whenDisposed, resolve: resolveDisposed } =
		Promise.withResolvers<void>();

	function broadcastDocUpdate(update: Uint8Array, origin: unknown) {
		if (isClosed) return;
		const frame = encodeSyncUpdate({ update });
		for (const session of sessions.values()) {
			if (session.origin === origin) continue;
			try {
				session.channel.sendFrame(frame);
			} catch (cause) {
				log.warn(
					IpcSyncServerError.FrameHandlingFailed({
						sessionId: session.id,
						cause,
					}),
				);
			}
		}
	}

	function broadcastAwarenessUpdate(
		{
			added,
			updated,
			removed,
		}: { added: number[]; updated: number[]; removed: number[] },
		origin: unknown,
	) {
		if (isClosed) return;
		if (!opts.awareness) return;
		const changedClients = added.concat(updated).concat(removed);
		const frame = encodeAwareness({
			update: encodeAwarenessUpdate(opts.awareness, changedClients),
		});
		for (const session of sessions.values()) {
			if (session.origin === origin) continue;
			try {
				session.channel.sendFrame(frame);
			} catch (cause) {
				log.warn(
					IpcSyncServerError.FrameHandlingFailed({
						sessionId: session.id,
						cause,
					}),
				);
			}
		}
	}

	ydoc.on('updateV2', broadcastDocUpdate);
	if (opts.awareness) opts.awareness.on('update', broadcastAwarenessUpdate);

	function teardownSession(session: SessionState) {
		if (!sessions.has(session.id)) return;
		sessions.delete(session.id);
		if (sessionsByClientId.get(session.clientId) === session) {
			sessionsByClientId.delete(session.clientId);
		}
		session.cleanup();
		if (opts.awareness) {
			removeAwarenessStates(
				opts.awareness,
				[session.clientId],
				session.origin,
			);
		}
		try {
			session.channel.close();
		} catch {
			// best effort; channel may already be closed
		}
		session.resolveClosed();
	}

	/**
	 * Decode and dispatch one inbound frame on a session's channel. SYNC and
	 * AWARENESS only; everything else is a no-op (the IPC wire deliberately
	 * omits SYNC_STATUS and RPC).
	 */
	function dispatchInboundFrame(
		session: SessionState,
		bytes: Uint8Array,
	) {
		try {
			const decoder = decoding.createDecoder(bytes);
			const messageType = decoding.readVarUint(decoder);
			switch (messageType) {
				case MESSAGE_TYPE.SYNC: {
					const syncType = decoding.readVarUint(decoder) as SyncMessageType;
					const payload = decoding.readVarUint8Array(decoder);
					const response = handleSyncPayload({
						syncType,
						payload,
						doc: ydoc,
						origin: session.origin,
					});
					if (response) session.channel.sendFrame(response);
					break;
				}
				case MESSAGE_TYPE.AWARENESS: {
					if (!opts.awareness) break;
					const update = decoding.readVarUint8Array(decoder);
					applyAwarenessUpdate(opts.awareness, update, session.origin);
					break;
				}
				default:
					break;
			}
		} catch (cause) {
			log.warn(
				IpcSyncServerError.FrameHandlingFailed({
					sessionId: session.id,
					cause,
				}),
			);
		}
	}

	/**
	 * Server-initiated half of the handshake: send STEP1 so the peer can
	 * reply with STEP2 carrying any updates the daemon is missing. The peer's
	 * own STEP1 (sent in parallel) drives the inverse direction. Returns true
	 * on success; false means the channel write failed and the session has
	 * been torn down.
	 */
	function sendInitialHandshake(session: SessionState): boolean {
		try {
			session.channel.sendFrame(encodeSyncStep1({ doc: ydoc }));
			if (opts.awareness && opts.awareness.getStates().size > 0) {
				session.channel.sendFrame(
					encodeAwarenessStates({
						awareness: opts.awareness,
						clients: Array.from(opts.awareness.getStates().keys()),
					}),
				);
			}
			return true;
		} catch (cause) {
			log.warn(
				IpcSyncServerError.FrameHandlingFailed({
					sessionId: session.id,
					cause,
				}),
			);
			teardownSession(session);
			return false;
		}
	}

	function registerSession(
		channel: IpcChannel,
		preamble: IpcPreamble,
	): SessionState {
		const sessionId = nextSessionId(opts.workspace);
		const sessionOrigin = Symbol(`hub:${sessionId}`);
		const { promise: whenClosed, resolve: resolveClosed } =
			Promise.withResolvers<void>();
		const unsubscribers: Array<() => void> = [];
		const session: SessionState = {
			id: sessionId,
			origin: sessionOrigin,
			clientId: preamble.clientId,
			deviceId: preamble.deviceId,
			isEphemeral: preamble.isEphemeral,
			connectedAt: Date.now(),
			channel,
			whenClosed,
			resolveClosed,
			cleanup: () => {
				for (const off of unsubscribers) {
					try {
						off();
					} catch {
						// best effort
					}
				}
			},
		};
		sessions.set(sessionId, session);
		sessionsByClientId.set(preamble.clientId, session);
		unsubscribers.push(
			channel.onFrame((bytes) => dispatchInboundFrame(session, bytes)),
		);
		unsubscribers.push(channel.onClose(() => teardownSession(session)));
		return session;
	}

	async function acceptSession(args: {
		channel: IpcChannel;
		preamble: IpcPreamble;
	}): Promise<void> {
		const { channel, preamble } = args;
		if (isClosed) {
			channel.close();
			return;
		}

		// Reconnect dedup: same-clientId twice means the previous peer crashed
		// without closing; the prior awareness state would linger and the
		// updateV2 broadcast loop would echo to the dead session.
		const prior = sessionsByClientId.get(preamble.clientId);
		if (prior) {
			log.info('kicking prior session for clientId reuse', {
				clientId: preamble.clientId,
				oldSessionId: prior.id,
			});
			teardownSession(prior);
		}

		const session = registerSession(channel, preamble);
		if (!sendInitialHandshake(session)) return;
		await session.whenClosed;
	}

	function peers(): SessionSnapshot[] {
		const out: SessionSnapshot[] = [];
		for (const session of sessions.values()) {
			out.push({
				sessionId: session.id,
				clientId: session.clientId,
				deviceId: session.deviceId,
				isEphemeral: session.isEphemeral,
				connectedAt: session.connectedAt,
			});
		}
		return out;
	}

	async function close(): Promise<void> {
		if (isClosed) {
			await whenDisposed;
			return;
		}
		isClosed = true;
		ydoc.off('updateV2', broadcastDocUpdate);
		if (opts.awareness) opts.awareness.off('update', broadcastAwarenessUpdate);
		const pending: Promise<void>[] = [];
		for (const session of Array.from(sessions.values())) {
			pending.push(session.whenClosed);
			teardownSession(session);
		}
		await Promise.all(pending);
		resolveDisposed();
	}

	// Doc destruction implies hub teardown. Mirrors the convention used by
	// `attachSqliteMaterializer`: callers don't have to remember to close.
	ydoc.once('destroy', () => {
		void close();
	});

	return {
		workspace: opts.workspace,
		acceptSession,
		peers,
		close,
		whenDisposed,
	};
}
