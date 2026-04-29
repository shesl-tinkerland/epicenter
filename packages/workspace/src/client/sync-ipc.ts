/**
 * Peer-side of the daemon's local IPC sync transport.
 *
 * `attachIpcSyncClient(ydoc, opts)` connects the script's local Y.Doc to the
 * daemon's hub over a unix socket. It drives the peer side of the Yjs sync
 * state machine, runs an exponential-backoff reconnect supervisor, and
 * exposes a small surface: `whenSynced`, `status`, `observe`, `close`,
 * `whenDisposed`.
 *
 * Wire vocabulary is SYNC and AWARENESS only. There is no `flush()` (no
 * SYNC_STATUS on the IPC wire), no `rpc()` (no IPC mailbox), and no
 * `find/peers/waitForPeer` surface; this is deliberately not a
 * `SyncAttachment`. Cross-device peer<T> RPC stays on cloud sync.
 *
 * The default transport opens a unix-socket connection via `Bun.connect`.
 * Tests inject a `connect` function that returns an in-memory channel pair,
 * which keeps the supervisor logic exercisable without a real socket.
 */

import * as decoding from 'lib0/decoding';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import {
	Awareness as YAwareness,
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
	removeAwarenessStates,
} from 'y-protocols/awareness';
import * as Y from 'yjs';

import {
	MESSAGE_TYPE,
	SYNC_MESSAGE_TYPE,
	encodeAwareness,
	encodeAwarenessStates,
	encodeSyncStep1,
	encodeSyncUpdate,
	handleSyncPayload,
	type SyncMessageType,
} from '@epicenter/sync';

import type { IpcChannel, IpcPreamble } from '../daemon/sync-hub.js';
import { createFrameReader, encodeFrame } from '../shared/ipc-framing.js';

// ============================================================================
// Types
// ============================================================================

export type IpcSyncStatus =
	| { phase: 'offline' }
	| { phase: 'connecting'; retries: number; lastError?: string }
	| { phase: 'connected' }
	| { phase: 'failed'; reason: string };

/**
 * Server's response to the peer's preamble. Carries any encryption keys the
 * server hands out for this workspace plus the server's own clientId for
 * awareness identification (when relevant).
 */
export type IpcPreambleReply = {
	workspaceGuid?: string;
	encryptionKeys?: unknown;
	serverClientId?: number;
	daemonManifest?: Record<string, string>;
};

export const IpcSyncClientError = defineErrors({
	/**
	 * The handshake's preamble reply carried a typed error from the daemon.
	 * `daemonErrorName` echoes the wellcrafted variant `name` from the wire
	 * (`'NoSuchWorkspace' | 'BadPreamble' | 'PreambleSchemaMismatch' | ...`)
	 * so callers can switch on it without a separate string vocabulary.
	 */
	HandshakeRejected: ({
		daemonErrorName,
		message,
	}: {
		daemonErrorName: string;
		message: string;
	}) => ({
		message: `[attachIpcSyncClient] daemon rejected handshake (${daemonErrorName}): ${message}`,
		daemonErrorName,
	}),
	/** A connect attempt threw before a session could start. */
	ConnectFailed: ({ cause }: { cause: unknown }) => ({
		message: `[attachIpcSyncClient] connect failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/** An inbound frame failed to decode or apply on the peer side. */
	FrameHandlingFailed: ({ cause }: { cause: unknown }) => ({
		message: `[attachIpcSyncClient] frame handling failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type IpcSyncClientError = InferErrors<typeof IpcSyncClientError>;

/**
 * Result of one connect attempt. The supervisor calls `dial()` per iteration
 * and either gets a `channel + reply` or an error to back-off and retry on.
 */
export type IpcDialResult = Result<
	{ channel: IpcChannel; reply: IpcPreambleReply },
	IpcSyncClientError
>;

export type IpcSyncClient = {
	/**
	 * Resolves after the first sync handshake completes (STEP2 lands or the
	 * initial UPDATE flushes). Rejects if the doc is destroyed before the
	 * first successful handshake.
	 */
	whenSynced: Promise<void>;
	/** Current connection status. */
	readonly status: IpcSyncStatus;
	/** Subscribe to status changes. Returns unsubscribe. */
	onStatusChange(listener: (status: IpcSyncStatus) => void): () => void;
	/** Subscribe to remote-driven doc/awareness fanouts. Returns unsubscribe. */
	observe(callback: () => void): () => void;
	/** Close the active connection and stop the supervisor. */
	close(): Promise<void>;
	/** Resolves after `close()` has fully settled and the doc is detached. */
	whenDisposed: Promise<void>;
};

// ============================================================================
// Constants
// ============================================================================

const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 10_000;

// ============================================================================
// Public API
// ============================================================================

export function attachIpcSyncClient(
	ydoc: Y.Doc,
	opts: {
		/** Unix socket path. Required unless a custom `connect` is provided. */
		socket?: string;
		/** Workspace selector advertised in the preamble. */
		workspace: string;
		/** Stable per-device identifier; published in the preamble. */
		deviceId: string;
		/** True for one-shot scripts (default); false for long-running peers. */
		isEphemeral?: boolean;
		/** Optional schema fingerprints per table (handshake validation). */
		schemaManifest?: Record<string, string>;
		/** Optional awareness instance bound to the same Y.Doc. */
		awareness?: YAwareness;
		/**
		 * Hook invoked after the daemon's preamble reply lands (before any sync
		 * frame is processed). Use to seed the script's keyring with the keys
		 * the daemon hands out at handshake time.
		 */
		onPreambleReply?: (reply: IpcPreambleReply) => void | Promise<void>;
		/**
		 * Custom dialer. Defaults to a Bun-unix-socket implementation when
		 * `opts.socket` is set. Tests inject an in-memory channel pair here so
		 * the supervisor is exercisable without a real socket.
		 */
		connect?: () => Promise<IpcDialResult>;
		log?: Logger;
	},
): IpcSyncClient {
	const log = opts.log ?? createLogger('attachIpcSyncClient');
	const isEphemeral = opts.isEphemeral ?? true;
	const status = createStatusEmitter<IpcSyncStatus>({ phase: 'offline' });
	const observers = new Set<() => void>();
	const backoff = createBackoff();
	const { promise: whenSynced, resolve: resolveSynced, reject: rejectSynced } =
		Promise.withResolvers<void>();
	let syncedSettled = false;
	const settleSynced = (op: () => void) => {
		if (syncedSettled) return;
		syncedSettled = true;
		op();
	};
	const { promise: whenDisposed, resolve: resolveDisposed } =
		Promise.withResolvers<void>();

	let desired: 'online' | 'offline' = 'online';
	let runId = 0;
	let isClosed = false;
	let activeChannel: IpcChannel | null = null;
	let activeOrigin: symbol | null = null;
	let supervisorPromise: Promise<void> | null = null;

	function notifyObservers() {
		for (const cb of observers) {
			try {
				cb();
			} catch (cause) {
				log.warn(IpcSyncClientError.FrameHandlingFailed({ cause }));
			}
		}
	}

	function dial(): Promise<IpcDialResult> {
		if (opts.connect) return opts.connect();
		if (!opts.socket) {
			throw new Error(
				'[attachIpcSyncClient] either `socket` or `connect` must be provided',
			);
		}
		return defaultBunDial(opts.socket, buildPreamble());
	}

	function buildPreamble(): IpcPreamble {
		return {
			workspace: opts.workspace,
			deviceId: opts.deviceId,
			clientId: ydoc.clientID,
			isEphemeral,
			schemaManifest: opts.schemaManifest,
		};
	}

	// ── Doc + awareness handlers (per-session) ──
	//
	// We register/unregister these per session so the origin filter tracks
	// the active session's origin symbol. Using a single shared origin would
	// either echo writes back (wrong receiver) or block fanouts in tests
	// that drive multiple sessions through the same client object over time.

	function onDocUpdate(update: Uint8Array, origin: unknown) {
		if (origin === activeOrigin) return;
		if (!activeChannel) return;
		try {
			activeChannel.sendFrame(encodeSyncUpdate({ update }));
		} catch (cause) {
			log.warn(IpcSyncClientError.FrameHandlingFailed({ cause }));
		}
	}

	function onAwarenessUpdate(
		{
			added,
			updated,
			removed,
		}: { added: number[]; updated: number[]; removed: number[] },
		origin: unknown,
	) {
		if (origin === activeOrigin) return;
		if (!activeChannel) return;
		if (!opts.awareness) return;
		const changedClients = added.concat(updated).concat(removed);
		try {
			activeChannel.sendFrame(
				encodeAwareness({
					update: encodeAwarenessUpdate(opts.awareness, changedClients),
				}),
			);
		} catch (cause) {
			log.warn(IpcSyncClientError.FrameHandlingFailed({ cause }));
		}
	}

	ydoc.on('updateV2', onDocUpdate);
	if (opts.awareness) opts.awareness.on('update', onAwarenessUpdate);

	// ── Supervisor loop ──

	async function runSession(
		channel: IpcChannel,
		myRunId: number,
	): Promise<'closed' | 'lost'> {
		const sessionOrigin = Symbol(`ipc-client:${myRunId}`);
		activeChannel = channel;
		activeOrigin = sessionOrigin;
		let handshakeComplete = false;
		const { promise: closedPromise, resolve: resolveClosed } =
			Promise.withResolvers<'closed' | 'lost'>();

		const offFrame = channel.onFrame((bytes) => {
			try {
				const decoder = decoding.createDecoder(bytes);
				const messageType = decoding.readVarUint(decoder);
				switch (messageType) {
					case MESSAGE_TYPE.SYNC: {
						const syncType = decoding.readVarUint(
							decoder,
						) as SyncMessageType;
						const payload = decoding.readVarUint8Array(decoder);
						const response = handleSyncPayload({
							syncType,
							payload,
							doc: ydoc,
							origin: sessionOrigin,
						});
						if (response) channel.sendFrame(response);
						if (
							!handshakeComplete &&
							(syncType === SYNC_MESSAGE_TYPE.STEP2 ||
								syncType === SYNC_MESSAGE_TYPE.UPDATE)
						) {
							handshakeComplete = true;
							status.set({ phase: 'connected' });
							settleSynced(() => resolveSynced());
						}
						notifyObservers();
						break;
					}
					case MESSAGE_TYPE.AWARENESS: {
						if (opts.awareness) {
							const update = decoding.readVarUint8Array(decoder);
							applyAwarenessUpdate(opts.awareness, update, sessionOrigin);
						}
						notifyObservers();
						break;
					}
					default:
						break;
				}
			} catch (cause) {
				log.warn(IpcSyncClientError.FrameHandlingFailed({ cause }));
			}
		});
		const offClose = channel.onClose(() => {
			resolveClosed(desired === 'offline' || isClosed ? 'closed' : 'lost');
		});

		// Fire our own STEP1 so the daemon can send any updates we're missing.
		// The daemon also sends its STEP1 (and any awareness states) on accept,
		// so the two STEP1/STEP2 exchanges happen in parallel.
		try {
			channel.sendFrame(encodeSyncStep1({ doc: ydoc }));
			if (opts.awareness && opts.awareness.getLocalState() !== null) {
				channel.sendFrame(
					encodeAwarenessStates({
						awareness: opts.awareness,
						clients: [ydoc.clientID],
					}),
				);
			}
		} catch (cause) {
			log.warn(IpcSyncClientError.FrameHandlingFailed({ cause }));
			channel.close();
		}

		const outcome = await closedPromise;
		offFrame();
		offClose();
		if (opts.awareness) {
			// Drop any peer-published states the awareness picked up on this
			// session so they don't leak into the next session's view.
			const others = Array.from(opts.awareness.getStates().keys()).filter(
				(client) => client !== ydoc.clientID,
			);
			if (others.length > 0) {
				removeAwarenessStates(opts.awareness, others, sessionOrigin);
			}
		}
		activeChannel = null;
		activeOrigin = null;
		return outcome;
	}

	async function runLoop() {
		while (desired === 'online' && !isClosed) {
			const myRunId = ++runId;
			status.set({
				phase: 'connecting',
				retries: backoff.retries,
			});

			const dialed = await safeDial();
			if (myRunId !== runId) continue;
			if (dialed.error !== null) {
				const isFatal = dialed.error.name === 'HandshakeRejected';
				if (isFatal) {
					status.set({ phase: 'failed', reason: dialed.error.message });
					settleSynced(() => rejectSynced(dialed.error));
					desired = 'offline';
					break;
				}
				status.set({
					phase: 'connecting',
					retries: backoff.retries,
					lastError: dialed.error.message,
				});
				if (desired === 'online') await backoff.sleep();
				continue;
			}

			const { channel, reply } = dialed.data;
			try {
				await opts.onPreambleReply?.(reply);
			} catch (cause) {
				log.warn(IpcSyncClientError.FrameHandlingFailed({ cause }));
			}

			const outcome = await runSession(channel, myRunId);
			if (outcome === 'closed') break;
			// 'lost': back off and retry
			backoff.bumpForLoss();
			if (desired === 'online') await backoff.sleep();
		}
		// Preserve a terminal `failed` status; otherwise transition to offline.
		if (status.get().phase !== 'failed') status.set({ phase: 'offline' });
	}

	async function safeDial(): Promise<IpcDialResult> {
		try {
			return await dial();
		} catch (cause) {
			return Err(IpcSyncClientError.ConnectFailed({ cause }).error);
		}
	}

	// Start the supervisor immediately (no waitFor analog: scripts have no
	// local persistence layer to gate on).
	supervisorPromise = runLoop().catch((cause) => {
		log.warn(IpcSyncClientError.FrameHandlingFailed({ cause }));
	});

	// ── Teardown ──

	async function close(): Promise<void> {
		if (isClosed) {
			await whenDisposed;
			return;
		}
		isClosed = true;
		desired = 'offline';
		runId++;
		const channel = activeChannel;
		ydoc.off('updateV2', onDocUpdate);
		if (opts.awareness) opts.awareness.off('update', onAwarenessUpdate);
		try {
			channel?.close();
		} catch {
			// best-effort
		}
		backoff.wake();
		const running = supervisorPromise;
		supervisorPromise = null;
		settleSynced(() => {
			rejectSynced(
				new Error('[attachIpcSyncClient] disposed before first handshake'),
			);
		});
		// Avoid leaving an unhandled rejection for the dispose-before-handshake
		// case if no one awaited whenSynced.
		whenSynced.catch(() => {});
		if (running) await running;
		if (status.get().phase !== 'failed') status.set({ phase: 'offline' });
		status.clear();
		resolveDisposed();
	}

	ydoc.once('destroy', () => {
		void close();
	});

	return {
		whenSynced,
		get status() {
			return status.get();
		},
		onStatusChange: status.subscribe,
		observe(callback) {
			observers.add(callback);
			return () => {
				observers.delete(callback);
			};
		},
		close,
		whenDisposed,
	};
}

// ============================================================================
// Default Bun unix-socket dialer
// ============================================================================

type BunIpcSocket = {
	write: (data: Uint8Array) => number | void;
	end: () => void;
};

async function defaultBunDial(
	socketPath: string,
	preamble: IpcPreamble,
): Promise<IpcDialResult> {
	const socketRef: { current: BunIpcSocket | null } = { current: null };
	const pendingWrites: Uint8Array[] = [];
	const frameListeners = new Set<(b: Uint8Array) => void>();
	const closeListeners = new Set<() => void>();
	let firstReplyConsumed = false;
	let closed = false;

	const { promise: replyPromise, resolve: resolveReply } =
		Promise.withResolvers<Uint8Array>();

	const reader = createFrameReader((frame) => {
		if (!firstReplyConsumed) {
			firstReplyConsumed = true;
			resolveReply(frame);
			return;
		}
		for (const cb of frameListeners) cb(frame);
	});

	function flushPending() {
		const sock = socketRef.current;
		if (!sock) return;
		while (pendingWrites.length > 0) {
			const buf = pendingWrites.shift()!;
			sock.write(buf);
		}
	}

	function fireClose() {
		if (closed) return;
		closed = true;
		for (const cb of closeListeners) cb();
	}

	const channel: IpcChannel = {
		sendFrame(bytes) {
			if (closed) return;
			const framed = encodeFrame(bytes);
			const sock = socketRef.current;
			if (sock) {
				sock.write(framed);
			} else {
				pendingWrites.push(framed);
			}
		},
		onFrame(cb) {
			frameListeners.add(cb);
			return () => frameListeners.delete(cb);
		},
		close() {
			if (closed) return;
			closed = true;
			try {
				socketRef.current?.end();
			} catch {
				// best-effort
			}
			for (const cb of closeListeners) cb();
		},
		onClose(cb) {
			closeListeners.add(cb);
			return () => closeListeners.delete(cb);
		},
	};

	const connectResult = await tryAsync({
		try: async () => {
			// biome-ignore lint/suspicious/noExplicitAny: Bun.connect socket-handler shape varies by environment
			const sock = await (Bun as any).connect({
				unix: socketPath,
				socket: {
					data(_socket: unknown, chunk: Uint8Array) {
						reader.push(chunk);
					},
					open(socket: BunIpcSocket) {
						socketRef.current = socket;
						const json = JSON.stringify(preamble);
						const payload = new TextEncoder().encode(json);
						socket.write(encodeFrame(payload));
						flushPending();
					},
					close() {
						fireClose();
					},
					end() {
						fireClose();
					},
					error(_socket: unknown, _err: Error) {
						fireClose();
					},
				},
			});
			return sock as BunIpcSocket;
		},
		catch: (cause) => IpcSyncClientError.ConnectFailed({ cause }),
	});
	if (connectResult.error !== null) return Err(connectResult.error);

	const replyFrame = await replyPromise;
	const text = new TextDecoder().decode(replyFrame);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (cause) {
		channel.close();
		return Err(IpcSyncClientError.ConnectFailed({ cause }).error);
	}
	const envelope = parsed as {
		data: IpcPreambleReply | null;
		error: { name?: string; message?: string } | null;
	};
	if (envelope.error) {
		channel.close();
		return Err(
			IpcSyncClientError.HandshakeRejected({
				daemonErrorName: envelope.error.name ?? 'Unknown',
				message: envelope.error.message ?? 'no message',
			}).error,
		);
	}
	return Ok({ channel, reply: envelope.data ?? {} });
}

// ============================================================================
// Helpers
// ============================================================================

function createStatusEmitter<T>(initial: T) {
	let current = initial;
	const listeners = new Set<(value: T) => void>();
	return {
		get() {
			return current;
		},
		set(value: T) {
			current = value;
			for (const listener of listeners) listener(value);
		},
		subscribe(listener: (value: T) => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		clear() {
			listeners.clear();
		},
	};
}

function createBackoff() {
	let retries = 0;
	let sleeper: { promise: Promise<void>; wake(): void } | null = null;

	return {
		async sleep() {
			const exponential = Math.min(BASE_DELAY_MS * 2 ** retries, MAX_DELAY_MS);
			const ms = exponential * (0.5 + Math.random() * 0.5);
			retries += 1;
			const { promise, resolve } = Promise.withResolvers<void>();
			const handle = setTimeout(resolve, ms);
			sleeper = {
				promise,
				wake() {
					clearTimeout(handle);
					resolve();
				},
			};
			await promise;
			sleeper = null;
		},
		wake() {
			sleeper?.wake();
		},
		bumpForLoss() {
			// Connection loss after a successful session: keep retries counter
			// monotonic so the next sleep already backs off rather than spinning.
			if (retries === 0) retries = 1;
		},
		reset() {
			retries = 0;
		},
		get retries() {
			return retries;
		},
	};
}
