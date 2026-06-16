/**
 * `openCollaboration`: the one collaboration primitive on a document.
 *
 * Connects a Yjs document to the relay, derives per-peer liveness and action
 * manifests from the server-owned presence channel, and wires inbound dispatch
 * text frames to the local action registry. Caller-side dispatch also rides
 * this socket: it sends `dispatch_request` and resolves from `dispatch_result`.
 *
 * Two wire surfaces ride one auth context:
 *
 *   binary WS frames  -> standard y-protocols SYNC.
 *   text WS frames    -> server -> client: presence (the full peer list
 *                        including each peer's action manifest, sent on
 *                        every membership or manifest change);
 *                        client -> server: presence_publish (this node's
 *                        manifest, sent once per connect) and
 *                        dispatch_request / dispatch_response;
 *                        server -> client: dispatch_inbound / dispatch_result.
 *
 * The Y.Doc holds durable workspace state; presence lives on the relay's
 * `connections` map; dispatch lives on the authenticated WebSocket.
 *
 * Content docs (rich-text bodies, attachments, nested independently-syncing
 * docs) use the same primitive with `actions: {}`: dispatch handlers stay
 * inert, the published manifest is empty, presence still flows in over the
 * socket for online discovery.
 */

import type { Logger } from 'wellcrafted/logger';
import type { Result } from 'wellcrafted/result';
import type * as Y from 'yjs';
import {
	ACTION_KEY_PATTERN,
	type ActionManifest,
	type ActionRegistry,
	toActionMeta,
} from '../shared/actions.js';
import {
	DispatchError,
	type DispatchRequest,
	interpretDispatchResult,
	runInboundDispatch,
} from './dispatch.js';
import {
	checkDispatchResultFrame,
	type DispatchRequestFrame,
} from './dispatch-protocol.js';
import {
	createSyncSupervisor,
	type OpenWebSocketFn,
} from './internal/sync-supervisor.js';
import {
	checkPresenceFrame,
	type Peer,
	type PresencePublishFrame,
} from './presence-protocol.js';

const DISPATCH_RESPONSE_CEILING_MS = 90_000;

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * Re-exported from the sync supervisor (its sole declaration) so consumers
 * keep importing `OpenWebSocketFn` from `open-collaboration` while the type has
 * one home. See {@link OpenWebSocketFn} for the contract.
 */
export type { OpenWebSocketFn };

/**
 * Subscribe to a wake signal that should trigger a sync reconnect (e.g. an
 * auth-state transition that may have refreshed the bearer). The callback
 * receives no argument and returns an unsubscribe. Pass `auth.onStateChange`
 * or any compatible function.
 */
export type OnReconnectSignal = (fn: () => void) => () => void;

export type OpenCollaborationConfig<TActions extends ActionRegistry> = {
	/**
	 * WebSocket URL the supervisor connects to, used verbatim. Callers
	 * build it via {@link roomWsUrl} (or any custom builder); the wire
	 * `?nodeId=` query that the relay routes by lives in this URL.
	 * `openCollaboration` does not parse, mutate, or augment it.
	 */
	url: string;
	/**
	 * Opens the relay socket. Pass `auth.openWebSocket` or any function
	 * with the same shape; the supervisor calls this on every connect and
	 * reconnect.
	 */
	openWebSocket: OpenWebSocketFn;
	/**
	 * Subscribe to a wake signal that should trigger a reconnect (token refresh,
	 * sign-in after reauth-required, sign-out then sign-in). Pass
	 * `auth.onStateChange` or any compatible function. The unsubscribe is wired
	 * into `whenDisposed`, so callers do not write reconnect glue.
	 */
	onReconnectSignal: OnReconnectSignal;
	waitFor?: Promise<unknown>;
	/**
	 * Optional deadline for the FIRST sync handshake. When set, the returned
	 * `whenConnected` rejects if STEP2/UPDATE does not land within this many ms.
	 * The supervisor keeps retrying regardless; only this handle's `whenConnected`
	 * view rejects. Omit for long-lived docs (the root doc) that should wait
	 * indefinitely; set it for one-shot reads that must give up if a room stalls.
	 */
	connectDeadlineMs?: number;
	log?: Logger;
	/**
	 * Injected local action registry. Collaboration publishes this registry to
	 * peers and uses it for inbound dispatch, but the caller remains the
	 * registry owner. Pass `{}` for content docs and consume-only participants.
	 * When the registry is empty, inbound `dispatch_inbound` frames always reply
	 * with `ActionNotFound`.
	 */
	actions: TActions;
};

// ════════════════════════════════════════════════════════════════════════════
// IMPLEMENTATION
// ════════════════════════════════════════════════════════════════════════════

/**
 * Reject `whenConnected` if the first handshake has not landed within
 * `deadlineMs`. Decorates the supervisor's one-shot promise without touching its
 * retry loop; the timer clears as soon as the underlying promise settles, so a
 * fast connect leaves no dangling handle. The caller tears the doc down on
 * rejection (e.g. `ydoc.destroy()`).
 */
function withConnectDeadline(
	whenConnected: Promise<void>,
	deadlineMs: number,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		whenConnected,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				reject(new Error(`sync handshake exceeded ${deadlineMs}ms`));
			}, deadlineMs);
		}),
	]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

export function openCollaboration<TActions extends ActionRegistry>(
	ydoc: Y.Doc,
	config: OpenCollaborationConfig<TActions>,
) {
	const userActions = config.actions;

	for (const key of Object.keys(userActions)) {
		if (!ACTION_KEY_PATTERN.test(key)) {
			throw new Error(
				`Invalid action key "${key}". Action keys must match ${ACTION_KEY_PATTERN.source} (snake_case ASCII, starting with a letter, max 64 chars).`,
			);
		}
	}

	const pendingDispatches = new Map<
		string,
		(result: Result<unknown, DispatchError>) => void
	>();

	function settlePendingDispatches(cause: unknown): void {
		const pending = [...pendingDispatches.values()];
		for (const settle of pending) {
			settle(DispatchError.NetworkFailed({ cause }));
		}
	}

	// Server-owned presence: the relay pushes the full peer list as a
	// `presence` text frame on every membership or manifest change. Each entry
	// carries the peer's nodeId, connectedAt, and published action
	// manifest. The client stores the latest list and notifies subscribers;
	// there is no delta protocol and no client-side reassembly. The relay
	// dedupes multi-tab same-node (newest-wins by connectedAt) and excludes
	// the receiver's own node, so the client stores `peers` verbatim.
	let remotePeers: Peer[] = [];
	const presenceListeners = new Set<(peers: Peer[]) => void>();

	// Returns true if `text` was a recognized `presence` frame (and thus
	// consumed); false if the caller should route it elsewhere (dispatch).
	function handlePresenceFrame(text: string): boolean {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return false;
		}
		if (!checkPresenceFrame.Check(parsed)) return false;
		remotePeers = parsed.peers;
		for (const listener of presenceListeners) listener(remotePeers);
		return true;
	}

	// Build the manifest once at construction time. The action registry is
	// fixed for the lifetime of this Collaboration, so we cache the JSON form
	// and publish it on every (re)connect.
	const ownManifest: ActionManifest = {};
	for (const [key, action] of Object.entries(userActions)) {
		ownManifest[key] = toActionMeta(action);
	}
	const presencePublishFrame = JSON.stringify({
		type: 'presence_publish',
		actions: ownManifest,
	} satisfies PresencePublishFrame);

	function handleDispatchResultFrame(text: string): boolean {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return false;
		}
		if (!checkDispatchResultFrame.Check(parsed)) return false;
		const settle = pendingDispatches.get(parsed.id);
		if (!settle) return true;
		settle(interpretDispatchResult(parsed.result));
		return true;
	}

	const supervisor = createSyncSupervisor(ydoc, {
		url: config.url,
		waitFor: config.waitFor,
		openWebSocket: config.openWebSocket,
		log: config.log,
		// Text frames carry two unrelated server-to-client channels:
		// presence (the full peer list) and dispatch. Try presence first,
		// then caller-side dispatch results, then recipient-side inbound calls.
		onTextFrame(text) {
			if (handlePresenceFrame(text)) return;
			if (handleDispatchResultFrame(text)) return;
			void runInboundDispatch({ rawFrame: text, actions: userActions }).then(
				(response) => {
					if (response !== null) supervisor.send(response);
				},
			);
		},
	});

	const unsubscribeStatusListener = supervisor.onStatusChange((status) => {
		if (status.phase === 'connected') {
			// Publish this node's action manifest on every (re)connect. The
			// relay stores it against the new socket and rebroadcasts presence
			// so peers see it.
			supervisor.send(presencePublishFrame);
			return;
		}
		settlePendingDispatches(new Error('Dispatch connection lost'));
	});

	// Reconnect wake: tell the live socket to retry whenever the caller signals
	// that credentials may have changed. Today the only producer is
	// `auth.onStateChange` (token refresh, reauth-required to signed-in,
	// sign-in after sign-out); the supervisor's own state machine decides
	// whether the reconnect actually does anything.
	const unsubscribeReconnectSignal = config.onReconnectSignal(() => {
		supervisor.reconnect();
	});

	void supervisor.whenDisposed.then(() => {
		unsubscribeStatusListener();
		unsubscribeReconnectSignal();
		settlePendingDispatches(new Error('Dispatch connection disposed'));
	});

	// `peers` reads the latest relay-pushed presence list directly.
	const peers = {
		list(): Peer[] {
			return remotePeers;
		},
		subscribe(fn: (peers: Peer[]) => void): () => void {
			presenceListeners.add(fn);
			return () => {
				presenceListeners.delete(fn);
			};
		},
	};

	// A connect deadline is a one-shot, caller-scoped view: only this handle's
	// `whenConnected` rejects after the deadline; the supervisor keeps retrying.
	const whenConnected =
		config.connectDeadlineMs === undefined
			? supervisor.whenConnected
			: withConnectDeadline(supervisor.whenConnected, config.connectDeadlineMs);

	return {
		/** Local action registry published through this collaboration handle. */
		get actions() {
			return userActions;
		},
		/** Current sync lifecycle status. */
		get status() {
			return supervisor.status;
		},
		/** Resolves after the first successful sync handshake. */
		whenConnected,
		/** Resolves after document destroy tears down collaboration. */
		whenDisposed: supervisor.whenDisposed,
		/** Subscribe to sync status changes. Returns an unsubscribe function. */
		onStatusChange: supervisor.onStatusChange,
		/** Restart the current connection cycle. */
		reconnect: supervisor.reconnect,
		/**
		 * Online peers in this workspace, derived from the server-owned
		 * presence channel.
		 */
		get peers() {
			return peers;
		},
		/**
		 * Fire a dispatch over the collaboration WebSocket. Always returns
		 * `Result<unknown, DispatchError>`.
		 */
		dispatch(req: DispatchRequest): Promise<Result<unknown, DispatchError>> {
			if (req.signal?.aborted) {
				return Promise.resolve(
					DispatchError.Cancelled({ reason: req.signal.reason }),
				);
			}
			if (supervisor.status.phase !== 'connected') {
				return Promise.resolve(
					DispatchError.NetworkFailed({
						cause: {
							reason: 'dispatch socket is not connected',
							phase: supervisor.status.phase,
						},
					}),
				);
			}

			const id = crypto.randomUUID();
			return new Promise<Result<unknown, DispatchError>>((resolve) => {
				let settle: (result: Result<unknown, DispatchError>) => void;
				const onAbort = () => {
					settle(DispatchError.Cancelled({ reason: req.signal?.reason }));
				};
				const ceiling = setTimeout(() => {
					settle(
						DispatchError.NetworkFailed({
							cause: {
								reason: 'no dispatch result from relay before ceiling',
								timeoutMs: DISPATCH_RESPONSE_CEILING_MS,
							},
						}),
					);
				}, DISPATCH_RESPONSE_CEILING_MS);

				settle = (result) => {
					if (!pendingDispatches.delete(id)) return;
					clearTimeout(ceiling);
					req.signal?.removeEventListener('abort', onAbort);
					resolve(result);
				};

				pendingDispatches.set(id, settle);
				req.signal?.addEventListener('abort', onAbort, { once: true });

				try {
					supervisor.send(
						JSON.stringify({
							type: 'dispatch_request',
							id,
							to: req.to,
							action: req.action,
							input: req.input,
						} satisfies DispatchRequestFrame),
					);
				} catch (cause) {
					settle(DispatchError.NetworkFailed({ cause }));
				}
			});
		},
		/** Destroy the Y.Doc, cascading teardown to attached primitives. */
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}

export type Collaboration<TActions extends ActionRegistry = ActionRegistry> =
	ReturnType<typeof openCollaboration<TActions>>;
