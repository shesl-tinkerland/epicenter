/// <reference lib="dom" />

import {
	decodeRpcPayload,
	encodeAwareness,
	encodeAwarenessStates,
	encodeRpcRequest,
	encodeRpcResponse,
	encodeSyncStep1,
	encodeSyncUpdate,
	handleSyncPayload,
	isRpcError,
	BEARER_SUBPROTOCOL_PREFIX,
	MAIN_SUBPROTOCOL,
	MESSAGE_TYPE,
	RpcError,
	SYNC_MESSAGE_TYPE,
	SYNC_ORIGIN,
	isTransportOrigin,
	type SyncMessageType,
} from '@epicenter/sync';
import * as decoding from 'lib0/decoding';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
	removeAwarenessStates,
} from 'y-protocols/awareness';
import * as Y from 'yjs';
import type { DefaultRpcMap, RpcActionMap } from '../rpc/types.js';
import {
	defineQuery,
	describeActions,
	invokeActionForRpc,
	type RemoteCallOptions,
	resolveActionPath,
	type SystemActions,
} from '../shared/actions.js';
import type {
	AwarenessAttachment,
	AwarenessSchema,
} from './attach-awareness.js';

/**
 * Minimal Y.Doc sync attachment: connects a Y.Doc to a WebSocket sync server.
 *
 * This is a low-level primitive for `packages/document`. It handles the
 * Y.Doc sync protocol (STEP1/STEP2/UPDATE), supervisor loop with exponential
 * backoff, liveness detection, and graceful shutdown.
 *
 * **Not included** (workspace-layer concerns):
 * - BroadcastChannel cross-tab sync (separate `attachBroadcastChannel` helper)
 * - Peer directory helpers over an attached awareness state
 * - Peer RPC (`sync.attachRpc(actions)`)
 *
 * Register `attachIndexedDb` first and pass its `whenLoaded`
 * as `waitFor` so the supervisor connects only after local state hydrates:
 * the handshake then exchanges only the delta, not the full document.
 *
 * `SYNC_ORIGIN` is imported from `@epicenter/sync` so every sync layer
 * (workspace WebSocket, BroadcastChannel, document attachSync) agrees on the
 * same symbol and echo guards work across layers.
 */

// ============================================================================
// Types
// ============================================================================

export type SyncError = { type: 'connection' };

/**
 * Reason a sync entered the terminal `failed` phase.
 *
 * `code` is `string` (not a closed enum): the server is the source of truth
 * for the vocabulary, so unknown codes pass through. Documented codes today:
 * 'invalid_token', 'token_expired', 'deauthorized', 'unknown'.
 */
export type SyncFailedReason = { type: 'auth'; code: string };

export type SyncStatus =
	| { phase: 'offline' }
	| { phase: 'connecting'; retries: number; lastError?: SyncError }
	| { phase: 'connected' }
	| { phase: 'failed'; reason: SyncFailedReason };

/**
 * Thrown via `whenConnected` rejection when the server signals a permanent
 * auth failure (close code 4401). The `code` carries the server's canonical
 * reason string so callers can switch on it without magic strings.
 */
export const SyncFailedError = defineErrors({
	AuthRejected: ({ code }: { code: string }) => ({
		message: `[attachSync] server rejected auth: ${code}`,
		code,
	}),
});
export type SyncFailedError = InferErrors<typeof SyncFailedError>;

/** Errors surfaced by the sync supervisor's background lifecycle. */
export const SyncSupervisorError = defineErrors({
	/**
	 * The `waitFor` barrier (typically IndexedDB hydration) rejected before
	 * the supervisor started. Sync proceeds anyway: better to try syncing
	 * than to stay silently offline because persistence failed.
	 */
	WaitForRejected: ({ cause }: { cause: unknown }) => ({
		message: `[attachSync] waitFor rejected; starting sync anyway: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/**
	 * The socket didn't fire 'close' within the shutdown timeout, so
	 * `whenDisposed` resolves anyway rather than hanging forever.
	 */
	CloseTimeout: ({ timeoutMs }: { timeoutMs: number }) => ({
		message: `[attachSync] WebSocket did not fire onclose within ${timeoutMs}ms; resolving whenDisposed anyway`,
		timeoutMs,
	}),
	PermanentClose: ({
		closeCode,
		reason,
	}: {
		closeCode: number;
		reason: SyncFailedReason;
	}) => ({
		message: `[attachSync] server sent permanent close ${closeCode}: ${reason.code}`,
		closeCode,
		reason,
	}),
});
export type SyncSupervisorError = InferErrors<typeof SyncSupervisorError>;

export type SyncAttachment = {
	/**
	 * Resolves after the WebSocket handshake completes and the first sync
	 * exchange finishes. Unlike `y-indexeddb`'s `whenSynced`, this is a
	 * real "transport established, initial state reconciled" guarantee.
	 *
	 * Rejects with an error if the doc is destroyed before the first
	 * successful handshake (permanent failure: dead URL, auth denied,
	 * dispose during outage). Callers awaiting it should attach a `.catch`
	 * or use `await using` to bound the wait by the doc's lifetime.
	 *
	 * Browser apps generally await `idb.whenLoaded` to render; only CLIs
	 * and tools that strictly need remote state await `whenConnected`.
	 */
	whenConnected: Promise<unknown>;
	/** Current connection status. */
	readonly status: SyncStatus;
	/** Subscribe to status changes. Returns unsubscribe function. */
	onStatusChange: (listener: (status: SyncStatus) => void) => () => void;
	/** Force a fresh connection with new credentials (supervisor restarts iteration). */
	reconnect(): void;
	/**
	 * Resolves after `ydoc.destroy()` fires the cascade, the supervisor loop exits,
	 * and any open websocket closes or reaches the safety timeout.
	 */
	whenDisposed: Promise<unknown>;
	attachRpc(actions: RpcActionSource): SyncRpcAttachment;
};

export type RpcActionSource = Record<string, unknown>;

export type SyncRpcAttachment = {
	rpc<
		TMap extends RpcActionMap = DefaultRpcMap,
		TAction extends string & keyof TMap = string & keyof TMap,
	>(
		target: number,
		action: TAction,
		input?: TMap[TAction]['input'],
		options?: RemoteCallOptions,
	): Promise<Result<TMap[TAction]['output'], RpcError>>;
};

/**
 * Anything with a `.whenLoaded` promise (typically `attachIndexedDb` or
 * `attachSqlite` results). Lets `waitFor` accept the attachment directly
 * rather than reaching into `.whenLoaded`.
 */
export type WaitForBarrier =
	| Promise<unknown>
	| { whenLoaded: Promise<unknown> };

/** First arg of `attachSync`: either a bare `Y.Doc` or a doc bundle. */
export type AttachSyncDoc = Y.Doc | { ydoc: Y.Doc };

export type SyncAttachmentConfig = {
	/**
	 * WebSocket URL for the room. Must use ws:/wss:. Use `toWsUrl()` to convert
	 * an HTTP URL. Typically interpolates `ydoc.guid` into the path.
	 */
	url: string;
	/**
	 * Gate the first connection attempt on another promise (typically
	 * `attachIndexedDb(ydoc).whenLoaded`). Accepts the attachment directly
	 * (uses its `.whenLoaded`) or a raw promise. Without this, the supervisor
	 * connects before local state hydrates and the handshake transfers the
	 * full document instead of just the delta.
	 */
	waitFor?: WaitForBarrier;
	/**
	 * Optional bearer-token augmentation for the WebSocket handshake.
	 *
	 * When omitted, `attachSync` opens a normal sync WebSocket with only the
	 * main Epicenter subprotocol. Browser cookie auth can still authenticate
	 * that upgrade if the API origin has a valid session cookie.
	 *
	 * When provided, the getter is called on every reconnect so token rotation
	 * is observed. A string return adds `bearer.<token>` to the subprotocol
	 * list. A null return sends no bearer subprotocol for this attempt. Browser
	 * cookie auth can still authenticate that upgrade through the cookie jar.
	 */
	bearerToken?: () => string | null;
	/**
	 * Logger for background supervisor failures (waitFor rejections, socket
	 * close timeouts). Defaults to a console-backed logger with source
	 * `attachSync`.
	 */
	log?: Logger;
	/**
	 * Optional awareness attachment to transport over the same WebSocket.
	 * When omitted, document sync works without creating awareness state.
	 */
	awareness?: AwarenessAttachment<AwarenessSchema>;
};

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_RPC_TIMEOUT_MS = 5_000;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;
const PING_INTERVAL_MS = 60_000;
const LIVENESS_TIMEOUT_MS = 90_000;
const LIVENESS_CHECK_INTERVAL_MS = 10_000;
const CONNECT_TIMEOUT_MS = 15_000;
/**
 * App-defined WebSocket close code (4000-4999 range) signaling the server
 * permanently rejected this connection's auth. Distinguishes "give up" from
 * transient close codes (1006 network blip, 1011 server error, etc.).
 */
const PERMANENT_AUTH_CLOSE_CODE = 4401;

/**
 * Failsafe: returns null when `event` is not a permanent-failure signal,
 * `SyncFailedReason` otherwise. A buggy server that sends 4401 with malformed
 * JSON or no reason still produces a usable reason (`code: 'unknown'`); we
 * never throw from here.
 */
function parsePermanentFailure(event: {
	code: number;
	reason: string;
}): SyncFailedReason | null {
	if (event.code !== PERMANENT_AUTH_CLOSE_CODE) return null;
	try {
		const parsed = JSON.parse(event.reason) as unknown;
		if (
			parsed !== null &&
			typeof parsed === 'object' &&
			'code' in parsed &&
			typeof (parsed as { code: unknown }).code === 'string'
		) {
			return { type: 'auth', code: (parsed as { code: string }).code };
		}
	} catch {
		// fall through to 'unknown'
	}
	return { type: 'auth', code: 'unknown' };
}

// ============================================================================
// Public API
// ============================================================================

export function toWsUrl(httpUrl: string): string {
	return httpUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

export function attachSync(
	doc: AttachSyncDoc,
	config: SyncAttachmentConfig,
): SyncAttachment {
	const ydoc = doc instanceof Y.Doc ? doc : doc.ydoc;
	let rpcActions: Record<string, unknown> | null = null;
	const awareness = config.awareness?.raw ?? null;

	const waitForPromise =
		config.waitFor && 'whenLoaded' in config.waitFor
			? config.waitFor.whenLoaded
			: config.waitFor;

	const log = config.log ?? createLogger('attachSync');

	const status = createStatusEmitter<SyncStatus>({ phase: 'offline' });
	function setStatus(next: SyncStatus) {
		const previous = status.get();
		status.set(next);
		if (previous.phase === next.phase) return;
		switch (next.phase) {
			case 'connected':
				log.info('sync connected', { phase: next.phase, docGuid: ydoc.guid });
				break;
			case 'failed':
				log.info('sync failed', {
					phase: next.phase,
					docGuid: ydoc.guid,
					reason: next.reason,
				});
				break;
			case 'offline':
				log.info('sync offline', { phase: next.phase, docGuid: ydoc.guid });
				break;
		}
	}
	// `whenConnected` settles in one of two ways: resolved when the first
	// successful handshake lands (STEP2/UPDATE), rejected when the doc is
	// destroyed before that happens. Without the destroy-side rejection,
	// callers awaiting `whenConnected` against a permanently dead URL or
	// failed auth would hang forever.
	const {
		promise: whenConnected,
		resolve: resolveConnected,
		reject: rejectConnected,
	} = Promise.withResolvers<void>();
	let connectedSettled = false;
	const settleConnected = (op: () => void) => {
		if (connectedSettled) return;
		connectedSettled = true;
		op();
	};
	const backoff = createBackoff();

	/**
	 * Set when the server signals permanent failure via close 4401. Read by
	 * `runLoop` to break the retry loop, and cleared by `reconnect()` so a
	 * subsequent attempt can leave the `failed` phase.
	 */
	let permanentFailure: SyncFailedReason | null = null;

	// `whenConnected` settles off status transitions. The first `connected`
	// resolves it; the first `failed` rejects with a typed `SyncFailedError`.
	// Doc-destroy still rejects via the destroy handler below; `connectedSettled`
	// gates double-settle.
	const unsubFirstSettle = status.subscribe((s) => {
		if (s.phase === 'connected') {
			settleConnected(resolveConnected);
			unsubFirstSettle();
		} else if (s.phase === 'failed') {
			// Attach the no-op catch BEFORE rejecting so the rejection isn't
			// unhandled when no consumer awaits (same pattern as the dispose
			// path further down).
			whenConnected.catch(() => {});
			const reason = s.reason;
			settleConnected(() => {
				rejectConnected(
					SyncFailedError.AuthRejected({ code: reason.code }).error,
				);
			});
			unsubFirstSettle();
		}
	});

	/**
	 * Cancellation hierarchy:
	 *
	 *   masterController: aborts on doc.destroy(); kills everything
	 *      cycleController: aborts on reconnect();
	 *                       kills the current supervisor iteration
	 *
	 * `cycleController` is replaced (not just re-aborted) by `reconnect()` so
	 * the new connection cycle has a fresh signal unrelated to the old one.
	 * Aborting an already-aborted controller is a no-op, which makes repeated
	 * reconnects structurally safe.
	 */
	const masterController = new AbortController();
	let cycleController: AbortController = childOf(masterController.signal);
	let waitForSettled = false;
	let destroyStarted = false;

	/** Current WebSocket instance, or null. */
	let websocket: WebSocket | null = null;

	/**
	 * Promise of the currently-running supervisor loop, or null when no loop
	 * is running. `ensureSupervisor` starts one if absent; teardown awaits it.
	 */
	let loopPromise: Promise<void> | null = null;

	// RPC state.
	//
	// `pendingRequests` tracks outbound RPCs awaiting a response. Cleared on
	// disconnect (the next connection is a fresh server-side context, so any
	// in-flight request from the prior connection will never resolve).
	const pendingRequests = new Map<
		number,
		{
			action: string;
			resolve: (result: Result<unknown, unknown>) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	let nextRequestId = 0;

	/** Resolve all pending RPC requests with Disconnected and clear state. */
	function clearPendingRequests() {
		const disconnected = RpcError.Disconnected();
		for (const [, pending] of pendingRequests) {
			clearTimeout(pending.timer);
			pending.resolve(disconnected);
		}
		pendingRequests.clear();
		nextRequestId = 0;
	}

	/**
	 * Handle an inbound RPC request: resolve against the attached RPC action
	 * tree and send the response back to the requester.
	 *
	 * When no dispatcher is configured, respond with `ActionNotFound` so the
	 * caller sees a typed error instead of a timeout.
	 */
	async function handleRpcRequest(rpc: {
		requestId: number;
		requesterClientId: number;
		action: string;
		input: unknown;
	}) {
		const sendResponse = (result: Result<unknown, unknown>) =>
			send(
				encodeRpcResponse({
					requestId: rpc.requestId,
					requesterClientId: rpc.requesterClientId,
					result,
				}),
			);

		// Resolve the action up front so a missing path surfaces as
		// ActionNotFound (typed) rather than ActionFailed wrapping a raw throw.
		const target = rpcActions
			? resolveActionPath(rpcActions, rpc.action)
			: null;
		if (!target) {
			sendResponse(RpcError.ActionNotFound({ action: rpc.action }));
			return;
		}

		sendResponse(await invokeActionForRpc(target, rpc.input, rpc.action));
	}

	// ── Message senders ──

	function send(message: Uint8Array) {
		if (websocket?.readyState === WebSocket.OPEN) {
			websocket.send(message);
		}
	}

	// ── Doc handlers ──

	function handleDocUpdate(update: Uint8Array, origin: unknown) {
		if (isTransportOrigin(origin)) return;
		send(encodeSyncUpdate({ update }));
	}

	function handleAwarenessUpdate(
		{
			added,
			updated,
			removed,
		}: { added: number[]; updated: number[]; removed: number[] },
		origin: unknown,
	) {
		if (!awareness || origin === SYNC_ORIGIN) return;
		const changedClients = added.concat(updated).concat(removed);
		send(
			encodeAwareness({
				update: encodeAwarenessUpdate(awareness, changedClients),
			}),
		);
	}

	function handleRemoteAwarenessUpdate(update: Uint8Array) {
		if (!awareness) return;
		applyAwarenessUpdate(awareness, update, SYNC_ORIGIN);
	}

	function sendLocalAwarenessState() {
		if (!awareness || awareness.getLocalState() === null) return;
		send(
			encodeAwarenessStates({
				awareness,
				clients: [ydoc.clientID],
			}),
		);
	}

	function sendKnownAwarenessStates() {
		if (!awareness) return;
		send(
			encodeAwarenessStates({
				awareness,
				clients: Array.from(awareness.getStates().keys()),
			}),
		);
	}

	function removeRemoteAwarenessStates() {
		if (!awareness) return;
		const remoteClientIds = Array.from(awareness.getStates().keys()).filter(
			(clientId) => clientId !== ydoc.clientID,
		);
		if (remoteClientIds.length === 0) return;
		removeAwarenessStates(awareness, remoteClientIds, SYNC_ORIGIN);
	}

	// ── Browser event handlers ──

	function handleOnline() {
		backoff.wake();
	}

	function handleOffline() {
		websocket?.close();
	}

	function handleVisibilityChange() {
		if (document.visibilityState !== 'visible') return;
		// Wakeup ping after the tab returns to foreground. The server is
		// expected to echo any inbound message via `liveness.touch()`, so
		// this also probes "is the wire actually responsive?" beyond what
		// the 60s PING_INTERVAL_MS keepalive covers. If the server doesn't
		// echo strings, focus events become a no-op for liveness. The
		// 90s LIVENESS_TIMEOUT_MS still catches a dead wire eventually.
		if (websocket?.readyState === WebSocket.OPEN) {
			websocket.send('ping');
		}
	}

	function manageWindowListeners(action: 'add' | 'remove') {
		const method =
			action === 'add' ? 'addEventListener' : 'removeEventListener';
		if (typeof window !== 'undefined') {
			window[method]('offline', handleOffline);
			window[method]('online', handleOnline);
		}
		if (typeof document !== 'undefined') {
			document[method]('visibilitychange', handleVisibilityChange);
		}
	}

	// Supervisor loop.

	async function runLoop(signal: AbortSignal) {
		let lastError: SyncError | undefined;

		while (!signal.aborted && !permanentFailure) {
			// Pending RPCs from the previous connection will never resolve.
			// clear them before starting a new attempt.
			clearPendingRequests();

			setStatus({ phase: 'connecting', retries: backoff.retries, lastError });

			const result = await attemptConnection(signal);
			if (signal.aborted) break;

			if (result === 'connected') {
				backoff.reset();
				lastError = undefined;
			} else {
				lastError = { type: 'connection' };
			}

			if (!signal.aborted) {
				await backoff.sleep(signal);
			}
		}

		setStatus(
			permanentFailure
				? { phase: 'failed', reason: permanentFailure }
				: { phase: 'offline' },
		);
		log.info('sync supervisor exited', {
			cause: permanentFailure
				? 'permanent-failure'
				: signal.aborted && destroyStarted
					? 'doc-destroyed'
					: signal.aborted
						? 'dispose'
						: 'offline',
			docGuid: ydoc.guid,
		});
	}

	async function attemptConnection(
		signal: AbortSignal,
	): Promise<'connected' | 'failed'> {
		let ws: WebSocket;
		try {
			const token = config.bearerToken?.() ?? null;
			const protocols = token
				? [MAIN_SUBPROTOCOL, `${BEARER_SUBPROTOCOL_PREFIX}${token}`]
				: [MAIN_SUBPROTOCOL];
			ws = new WebSocket(config.url, protocols);
		} catch {
			return 'failed';
		}
		ws.binaryType = 'arraybuffer';
		websocket = ws;

		const { promise: openPromise, resolve: resolveOpen } =
			Promise.withResolvers<boolean>();
		const { promise: closePromise, resolve: resolveClose } =
			Promise.withResolvers<void>();
		let handshakeComplete = false;

		const liveness = createLivenessMonitor(ws);

		const connectTimeout = setTimeout(() => {
			if (ws.readyState === WebSocket.CONNECTING) ws.close();
		}, CONNECT_TIMEOUT_MS);

		// Cycle abort closes the in-flight socket so `closePromise` resolves
		// and the loop can iterate. Listener auto-detaches when this socket's
		// own close fires (we wire ws.onclose to call cleanupAbortListener).
		const onAbort = () => {
			if (
				ws.readyState !== WebSocket.CLOSED &&
				ws.readyState !== WebSocket.CLOSING
			) {
				ws.close();
			}
		};
		const cleanupAbortListener = () => {
			signal.removeEventListener('abort', onAbort);
		};
		if (signal.aborted) {
			onAbort();
		} else {
			signal.addEventListener('abort', onAbort, { once: true });
		}

		ws.onopen = () => {
			clearTimeout(connectTimeout);
			send(encodeSyncStep1({ doc: ydoc }));

			sendLocalAwarenessState();

			liveness.start();
			resolveOpen(true);
		};

		ws.onclose = (event: CloseEvent) => {
			clearTimeout(connectTimeout);
			cleanupAbortListener();
			liveness.stop();
			removeRemoteAwarenessStates();
			const failure = parsePermanentFailure(event);
			if (failure) {
				permanentFailure = failure;
				log.warn(
					SyncSupervisorError.PermanentClose({
						closeCode: event.code,
						reason: failure,
					}),
				);
			}
			websocket = null;
			resolveOpen(false);
			resolveClose();
		};

		ws.onerror = () => {
			resolveOpen(false);
		};

		ws.onmessage = (event: MessageEvent) => {
			liveness.touch();
			if (typeof event.data === 'string') return;

			const data: Uint8Array = new Uint8Array(event.data);
			const decoder = decoding.createDecoder(data);
			const messageType = decoding.readVarUint(decoder);

			switch (messageType) {
				case MESSAGE_TYPE.SYNC: {
					const syncType = decoding.readVarUint(decoder) as SyncMessageType;
					const payload = decoding.readVarUint8Array(decoder);
					const response = handleSyncPayload({
						syncType,
						payload,
						doc: ydoc,
						origin: SYNC_ORIGIN,
					});
					if (response) {
						send(response);
					} else if (
						!handshakeComplete &&
						(syncType === SYNC_MESSAGE_TYPE.STEP2 ||
							syncType === SYNC_MESSAGE_TYPE.UPDATE)
					) {
						handshakeComplete = true;
						setStatus({ phase: 'connected' });
					}
					break;
				}

				case MESSAGE_TYPE.AWARENESS: {
					handleRemoteAwarenessUpdate(decoding.readVarUint8Array(decoder));
					break;
				}

				case MESSAGE_TYPE.QUERY_AWARENESS: {
					sendKnownAwarenessStates();
					break;
				}

				case MESSAGE_TYPE.RPC: {
					const rpc = decodeRpcPayload(decoder);
					if (rpc.type === 'response') {
						const pending = pendingRequests.get(rpc.requestId);
						if (pending) {
							clearTimeout(pending.timer);
							pendingRequests.delete(rpc.requestId);
							// Trust-the-wire cast: the JSON payload is structurally a
							// Result, but decodeRpcPayload types it as the raw shape.
							pending.resolve(rpc.result as Result<unknown, unknown>);
						}
					} else if (rpc.type === 'request') {
						void handleRpcRequest(rpc);
					}
					break;
				}
			}
		};

		const opened = await openPromise;
		if (!opened || signal.aborted) {
			if (
				ws.readyState !== WebSocket.CLOSED &&
				ws.readyState !== WebSocket.CLOSING
			) {
				ws.close();
			}
			await closePromise;
			return 'failed';
		}

		await closePromise;
		return handshakeComplete ? 'connected' : 'failed';
	}

	function ensureSupervisor() {
		if (masterController.signal.aborted) return;
		if (!waitForSettled) return;
		if (loopPromise) return;
		manageWindowListeners('add');
		const signal = cycleController.signal;
		loopPromise = runLoop(signal).finally(() => {
			loopPromise = null;
			// If `reconnect()` swapped in a fresh cycleController while we were
			// draining (e.g., a status subscriber called `reconnect()` from
			// inside `runLoop`'s synchronous tail), the new cycle won't have
			// started yet. Detect this and chain a fresh loop. Without this,
			// the reconnect's `ensureSupervisor` early-returned because
			// loopPromise was still set, and the supervisor would silently die.
			if (
				!masterController.signal.aborted &&
				!permanentFailure &&
				cycleController.signal !== signal &&
				!cycleController.signal.aborted
			) {
				ensureSupervisor();
			}
		});
	}

	function reconnect() {
		if (masterController.signal.aborted) return;
		permanentFailure = null;
		cycleController.abort();
		cycleController = childOf(masterController.signal);
		backoff.reset();
		if (waitForSettled) manageWindowListeners('add');
		ensureSupervisor();
	}

	// ── Attach listeners + start ──

	ydoc.on('updateV2', handleDocUpdate);
	awareness?.on('update', handleAwarenessUpdate);

	// Gate the first connection on `waitFor` (typically idb.whenLoaded).
	// If `waitFor` rejects, log but still start: better to try syncing than
	// silently stay offline because persistence failed.
	void (async () => {
		try {
			await waitForPromise;
		} catch (cause) {
			log.warn(SyncSupervisorError.WaitForRejected({ cause }));
		}
		waitForSettled = true;
		ensureSupervisor();
	})();

	// Teardown.

	// `whenDisposed` resolves only after the supervisor loop has fully exited
	// and any still-open socket has hit CLOSED, or the safety timeout elapses.
	const { promise: whenDisposed, resolve: resolveDisposed } =
		Promise.withResolvers<void>();
	ydoc.once('destroy', async () => {
		destroyStarted = true;
		try {
			// Master abort cascades to cycleController (closes ws, wakes
			// backoff sleep, fires attemptConnection's abort listener).
			masterController.abort();
			// Reject `whenConnected` if dispose lands before the first handshake
			// (permanent failure: dead URL, denied auth). Callers awaiting it
			// would otherwise hang forever. The doc is gone, so the promise must
			// settle. Attach a no-op catch BEFORE rejecting so the rejection
			// isn't unhandled when no consumer awaits.
			whenConnected.catch(() => {});
			settleConnected(() => {
				rejectConnected(
					new Error('[attachSync] doc destroyed before first handshake'),
				);
			});
			ydoc.off('updateV2', handleDocUpdate);
			awareness?.off('update', handleAwarenessUpdate);
			const ws = websocket;
			clearPendingRequests();
			manageWindowListeners('remove');
			status.clear();
			if (loopPromise) await loopPromise;
			await waitForWsClose(ws, 1000, log);
		} finally {
			resolveDisposed();
		}
	});

	return {
		whenConnected,
		get status() {
			return status.get();
		},
		onStatusChange: status.subscribe,
		reconnect,
		whenDisposed,
		attachRpc(userActions) {
			if (rpcActions) throw new Error('[attachSync] RPC already attached');
			if ('system' in userActions) {
				throw new Error(
					"User actions cannot define the 'system.*' namespace. It is reserved for runtime meta operations.",
				);
			}
			const systemActions: SystemActions = Object.freeze({
				describe: defineQuery({
					handler: () => describeActions(userActions),
				}),
			});
			rpcActions = Object.freeze({
				...userActions,
				system: systemActions,
			});
			return {
				rpc: async <
					TMap extends RpcActionMap = DefaultRpcMap,
					TAction extends string & keyof TMap = string & keyof TMap,
				>(
					target: number,
					action: TAction,
					input?: TMap[TAction]['input'],
					{ timeout = DEFAULT_RPC_TIMEOUT_MS }: { timeout?: number } = {},
				): Promise<Result<TMap[TAction]['output'], RpcError>> => {
					if (target === ydoc.clientID) {
						return RpcError.ActionFailed({
							action,
							cause: 'Cannot RPC to self, call the action directly',
						});
					}

					if (masterController.signal.aborted) return RpcError.Disconnected();

					if (websocket?.readyState !== WebSocket.OPEN) {
						return RpcError.Disconnected();
					}

					return new Promise((resolve) => {
						const requestId = nextRequestId++;
						send(
							encodeRpcRequest({
								requestId,
								targetClientId: target,
								requesterClientId: ydoc.clientID,
								action,
								input,
							}),
						);

						const timer = setTimeout(() => {
							pendingRequests.delete(requestId);
							resolve(RpcError.Timeout({ ms: timeout }));
						}, timeout);

						pendingRequests.set(requestId, {
							action,
							resolve: (result) => {
								clearTimeout(timer);
								if (isRpcError(result.error)) {
									resolve(Err(result.error));
								} else if (result.error != null) {
									resolve(
										RpcError.ActionFailed({
											action,
											cause: result.error,
										}),
									);
								} else {
									resolve(Ok(result.data as TMap[TAction]['output']));
								}
							},
							timer,
						});
					});
				},
			};
		},
	};
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

function createLivenessMonitor(ws: WebSocket) {
	let pingInterval: ReturnType<typeof setInterval> | null = null;
	let livenessInterval: ReturnType<typeof setInterval> | null = null;
	let lastMessageTime = 0;

	function stop() {
		if (pingInterval) clearInterval(pingInterval);
		if (livenessInterval) clearInterval(livenessInterval);
	}

	return {
		start() {
			stop();
			lastMessageTime = Date.now();

			pingInterval = setInterval(() => {
				if (ws.readyState === WebSocket.OPEN) ws.send('ping');
			}, PING_INTERVAL_MS);

			livenessInterval = setInterval(() => {
				if (Date.now() - lastMessageTime > LIVENESS_TIMEOUT_MS) {
					ws.close();
				}
			}, LIVENESS_CHECK_INTERVAL_MS);
		},
		touch() {
			lastMessageTime = Date.now();
		},
		stop,
	};
}

/**
 * Await a WebSocket's `close` event, with a timeout safeguard.
 *
 * Resolves immediately if the socket is null or already CLOSED. Otherwise
 * attaches a one-shot `close` listener and races it against `timeoutMs`.
 * A misbehaving server that never sends a close frame shouldn't block
 * teardown indefinitely.
 */
function waitForWsClose(
	ws: WebSocket | null,
	timeoutMs: number,
	log: Logger,
): Promise<void> {
	if (!ws || ws.readyState === WebSocket.CLOSED) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const onClose = () => {
			clearTimeout(timer);
			resolve();
		};
		ws.addEventListener('close', onClose, { once: true });
		const timer = setTimeout(() => {
			ws.removeEventListener('close', onClose);
			log.warn(SyncSupervisorError.CloseTimeout({ timeoutMs }));
			resolve();
		}, timeoutMs);
	});
}

function createBackoff() {
	let retries = 0;
	let externalWake: (() => void) | null = null;

	return {
		/**
		 * Sleep for exponentially-jittered backoff. Returns early on `signal`
		 * abort or on an explicit `wake()` (e.g. window 'online' event). Never
		 * throws. Callers re-check `signal.aborted` after.
		 */
		async sleep(signal: AbortSignal): Promise<void> {
			const exponential = Math.min(BASE_DELAY_MS * 2 ** retries, MAX_DELAY_MS);
			const ms = exponential * (0.5 + Math.random() * 0.5);
			retries += 1;

			if (signal.aborted) return;

			return new Promise<void>((resolve) => {
				const cleanup = () => {
					clearTimeout(handle);
					signal.removeEventListener('abort', onAbort);
					externalWake = null;
				};
				const handle = setTimeout(() => {
					cleanup();
					resolve();
				}, ms);
				const onAbort = () => {
					cleanup();
					resolve();
				};
				signal.addEventListener('abort', onAbort, { once: true });
				externalWake = () => {
					cleanup();
					resolve();
				};
			});
		},
		/** External wake (e.g. window 'online' event): short-circuits the sleep without aborting the cycle. */
		wake() {
			externalWake?.();
		},
		reset() {
			retries = 0;
		},
		get retries() {
			return retries;
		},
	};
}

/**
 * Build an `AbortController` whose signal is aborted whenever `parent` is.
 * Aborting the child does NOT abort the parent. The parent→child listener
 * self-cleans when the child is aborted first via the `signal` option.
 */
function childOf(parent: AbortSignal): AbortController {
	const child = new AbortController();
	if (parent.aborted) {
		child.abort(parent.reason);
	} else {
		parent.addEventListener('abort', () => child.abort(parent.reason), {
			once: true,
			signal: child.signal,
		});
	}
	return child;
}
