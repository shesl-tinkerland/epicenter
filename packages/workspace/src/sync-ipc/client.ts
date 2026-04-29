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
 *
 * Lifecycle uses one `AbortController`. `close()` aborts; `runLoop` exits
 * cleanly on the next await; the active session's listeners detach in their
 * own `finally`. No global mutable doc/awareness listeners; each session
 * registers its own and removes them when the session ends.
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

import { createFrameReader, encodeFrame } from './framing.js';
import type { IpcChannel, IpcPreamble, IpcPreambleReply } from './types.js';

// ============================================================================
// Types
// ============================================================================

export type IpcSyncStatus =
	| { phase: 'offline' }
	| { phase: 'connecting'; retries: number; lastError?: string }
	| { phase: 'connected' }
	| { phase: 'failed'; reason: string };

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

let sessionSeq = 0;

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
	const controller = new AbortController();
	const { promise: whenSynced, resolve: resolveSynced, reject: rejectSynced } =
		Promise.withResolvers<void>();
	let syncedSettled = false;
	const settleSynced = (op: () => void) => {
		if (syncedSettled) return;
		syncedSettled = true;
		op();
	};
	// Avoid an unhandled rejection if no consumer awaits whenSynced.
	whenSynced.catch(() => {});

	const { promise: whenDisposed, resolve: resolveDisposed } =
		Promise.withResolvers<void>();

	function notifyObservers() {
		for (const cb of observers) {
			try {
				cb();
			} catch (cause) {
				log.warn(IpcSyncClientError.FrameHandlingFailed({ cause }));
			}
		}
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

	function dial(): Promise<IpcDialResult> {
		if (opts.connect) return opts.connect();
		if (!opts.socket) {
			throw new Error(
				'[attachIpcSyncClient] either `socket` or `connect` must be provided',
			);
		}
		return defaultBunDial(opts.socket, buildPreamble());
	}

	async function safeDial(): Promise<IpcDialResult> {
		try {
			return await dial();
		} catch (cause) {
			return Err(IpcSyncClientError.ConnectFailed({ cause }).error);
		}
	}

	// ── Per-session unit-of-work ──────────────────────────────────────────
	//
	// Every session installs its own doc/awareness listeners and removes them
	// in its `finally`. There is no "active channel" singleton outside the
	// session: between sessions, the doc is unobserved, so writes during
	// reconnect simply queue up in the local Y.Doc and ride the next
	// handshake's STEP1/STEP2 exchange.
	async function runSession(
		channel: IpcChannel,
		signal: AbortSignal,
	): Promise<'closed' | 'lost'> {
		const sessionOrigin = Symbol(`ipc-client:${++sessionSeq}`);
		let handshakeComplete = false;
		const { promise: closedPromise, resolve: resolveClosed } =
			Promise.withResolvers<'closed' | 'lost'>();

		const onDocUpdate = (update: Uint8Array, origin: unknown) => {
			if (origin === sessionOrigin) return;
			try {
				channel.sendFrame(encodeSyncUpdate({ update }));
			} catch (cause) {
				log.warn(IpcSyncClientError.FrameHandlingFailed({ cause }));
			}
		};
		const onAwarenessUpdate = (
			{
				added,
				updated,
				removed,
			}: { added: number[]; updated: number[]; removed: number[] },
			origin: unknown,
		) => {
			if (origin === sessionOrigin) return;
			if (!opts.awareness) return;
			const changedClients = added.concat(updated).concat(removed);
			try {
				channel.sendFrame(
					encodeAwareness({
						update: encodeAwarenessUpdate(opts.awareness, changedClients),
					}),
				);
			} catch (cause) {
				log.warn(IpcSyncClientError.FrameHandlingFailed({ cause }));
			}
		};

		ydoc.on('updateV2', onDocUpdate);
		if (opts.awareness) opts.awareness.on('update', onAwarenessUpdate);

		const offFrame = channel.onFrame((bytes) => {
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
							settleSynced(resolveSynced);
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
			resolveClosed(signal.aborted ? 'closed' : 'lost');
		});

		const onAbort = () => channel.close();
		signal.addEventListener('abort', onAbort);

		// Send our STEP1 in parallel with whatever the daemon sent on accept.
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

		try {
			return await closedPromise;
		} finally {
			ydoc.off('updateV2', onDocUpdate);
			if (opts.awareness) opts.awareness.off('update', onAwarenessUpdate);
			offFrame();
			offClose();
			signal.removeEventListener('abort', onAbort);
			if (opts.awareness) {
				const others = Array.from(opts.awareness.getStates().keys()).filter(
					(client) => client !== ydoc.clientID,
				);
				if (others.length > 0) {
					removeAwarenessStates(opts.awareness, others, sessionOrigin);
				}
			}
		}
	}

	// ── Supervisor loop ──────────────────────────────────────────────────
	//
	// Dial → run session → on loss, sleep → repeat. One cancellation source
	// (controller.signal) drives the whole thing. A fatal handshake error
	// (e.g. NoSuchWorkspace) settles `whenSynced` as a rejection and exits.

	async function runLoop(signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			status.set({ phase: 'connecting', retries: backoff.retries });
			const dialed = await safeDial();
			if (signal.aborted) break;

			if (dialed.error !== null) {
				if (dialed.error.name === 'HandshakeRejected') {
					status.set({ phase: 'failed', reason: dialed.error.message });
					settleSynced(() => rejectSynced(dialed.error));
					break;
				}
				status.set({
					phase: 'connecting',
					retries: backoff.retries,
					lastError: dialed.error.message,
				});
				await sleepWithSignal(backoff.next(), signal);
				continue;
			}

			try {
				await opts.onPreambleReply?.(dialed.data.reply);
			} catch (cause) {
				log.warn(IpcSyncClientError.FrameHandlingFailed({ cause }));
			}

			const outcome = await runSession(dialed.data.channel, signal);
			if (outcome === 'closed') break;
			await sleepWithSignal(backoff.next(), signal);
		}

		// Preserve a terminal `failed` status; otherwise settle to offline.
		if (status.get().phase !== 'failed') status.set({ phase: 'offline' });
	}

	const supervisor = runLoop(controller.signal).catch((cause) => {
		log.warn(IpcSyncClientError.FrameHandlingFailed({ cause }));
	});

	// ── Teardown ─────────────────────────────────────────────────────────

	async function close(): Promise<void> {
		if (controller.signal.aborted) {
			await whenDisposed;
			return;
		}
		controller.abort();
		settleSynced(() => {
			rejectSynced(
				new Error('[attachIpcSyncClient] disposed before first handshake'),
			);
		});
		await supervisor;
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
//
// `Bun.connect({ unix, socket: { open, data, ... } })` is callback-based:
// `open(socket)` fires once with the live socket; `data(socket, chunk)`
// fires per byte chunk. We:
//   1. Build the framer + channel object up front.
//   2. Call Bun.connect; in `open()` we capture the live socket and write
//      the preamble as the first framed message.
//   3. Wait for the framer to emit one frame (the daemon's preamble reply).
//   4. Parse that frame as a serialized wellcrafted Result envelope.
//   5. Return the channel for the supervisor to drive.
//
// The channel cannot be used by anyone until step 5 returns, so we do not
// need a pending-write buffer for "what if sendFrame is called before the
// socket is open?": it isn't.

type BunIpcSocket = {
	write: (data: Uint8Array) => number | void;
	end: () => void;
};

async function defaultBunDial(
	socketPath: string,
	preamble: IpcPreamble,
): Promise<IpcDialResult> {
	let socket: BunIpcSocket | null = null;
	let closed = false;
	const frameListeners = new Set<(b: Uint8Array) => void>();
	const closeListeners = new Set<() => void>();
	let firstFrameConsumed = false;
	const { promise: replyPromise, resolve: resolveReply } =
		Promise.withResolvers<Uint8Array>();

	const reader = createFrameReader((frame) => {
		if (!firstFrameConsumed) {
			firstFrameConsumed = true;
			resolveReply(frame);
			return;
		}
		for (const cb of frameListeners) cb(frame);
	});

	function fireClose() {
		if (closed) return;
		closed = true;
		for (const cb of closeListeners) cb();
	}

	const channel: IpcChannel = {
		sendFrame(bytes) {
			if (closed || !socket) return;
			socket.write(encodeFrame(bytes));
		},
		onFrame(cb) {
			frameListeners.add(cb);
			return () => frameListeners.delete(cb);
		},
		close() {
			if (closed) return;
			try {
				socket?.end();
			} catch {
				// best-effort
			}
			fireClose();
		},
		onClose(cb) {
			closeListeners.add(cb);
			return () => closeListeners.delete(cb);
		},
	};

	const connectResult = await tryAsync({
		try: async () => {
			// biome-ignore lint/suspicious/noExplicitAny: Bun socket-handler types vary
			return (await (Bun as any).connect({
				unix: socketPath,
				socket: {
					data(_s: unknown, chunk: Uint8Array) {
						reader.push(chunk);
					},
					open(s: BunIpcSocket) {
						socket = s;
						const json = JSON.stringify(preamble);
						s.write(encodeFrame(new TextEncoder().encode(json)));
					},
					close() {
						fireClose();
					},
					end() {
						fireClose();
					},
					error(_s: unknown, _err: Error) {
						fireClose();
					},
				},
			})) as BunIpcSocket;
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

/**
 * Exponential backoff with jitter. `next()` returns the ms to sleep for the
 * upcoming attempt and increments the retry counter. Never resets: we accept
 * "lose connection right after success → retry instantly" as a simpler
 * contract than tracking last-success-time and conditionally resetting.
 */
function createBackoff() {
	let retries = 0;
	return {
		next(): number {
			const exponential = Math.min(BASE_DELAY_MS * 2 ** retries, MAX_DELAY_MS);
			const ms = exponential * (0.5 + Math.random() * 0.5);
			retries += 1;
			return ms;
		},
		get retries() {
			return retries;
		},
	};
}

/**
 * `setTimeout` that resolves early on abort. Replacement for Bun.sleep when
 * we want the supervisor to wake up immediately on `close()`.
 */
function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		signal.addEventListener('abort', onAbort, { once: true });
	});
}
