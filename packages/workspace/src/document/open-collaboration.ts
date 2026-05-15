/**
 * `openCollaboration`: the one collaboration primitive on a document.
 *
 * Identity, presence, and RPC all live in Y.Doc state. The workspace ydoc
 * reserves two top-level Y.Arrays (see `keys.ts`):
 *
 *     RPC_KEY       'rpc'        backs YKeyValueLww<Call>
 *     PRESENCE_KEY  'presence'   backs YKeyValueLww<PresenceEntry>
 *
 * The wire is plain Yjs sync. Calls are LWW rows whose `response` flips from
 * `null` to `Result`; presence is a server-written row per connected socket.
 * No awareness, no RPC envelopes, no runtime envelopes.
 *
 * Routing is by per-socket `connId` (client-minted at startup, echoed by the
 * server as a query param). `replicaId` is install-stable but can map to many
 * `connId`s (one per tab). Callers pick a concrete connection at the call
 * site: `collab.peers.list().find((p) => p.replicaId === id)` for "any tab,"
 * `peers.list().filter(...)` for fan-out. The presence surface deliberately
 * does not hide that choice behind a `find` verb.
 *
 * Content docs (rich-text bodies, attachments, anything nested under a parent
 * that syncs independently) use this same primitive with `actions: {}`: the
 * action runner is skipped entirely and the byte transport is identical.
 */

import type { Logger } from 'wellcrafted/logger';
import type { Result } from 'wellcrafted/result';
import type * as Y from 'yjs';
import { ACTION_KEY_PATTERN, type ActionRegistry } from '../shared/actions.js';
import {
	createSyncSupervisor,
	type OpenWebSocket,
	type SyncStatus,
} from './internal/sync-supervisor.js';
import { PRESENCE_KEY, RPC_KEY } from './keys.js';
import {
	createPresenceSurface,
	type PresenceEntry,
	type PresenceSurface,
} from './presence.js';
import {
	attachActionRunner,
	type Call,
	type DispatchError,
	type DispatchOptions,
	dispatch as dispatchCall,
} from './rpc.js';
import { YKeyValueLww } from './y-keyvalue/y-keyvalue-lww.js';

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC TYPES
// ════════════════════════════════════════════════════════════════════════════

export type OpenCollaborationConfig<TActions extends ActionRegistry> = {
	url: string;
	waitFor?: Promise<unknown>;
	openWebSocket?: OpenWebSocket;
	log?: Logger;
	/**
	 * Install-stable replica id. Identifies "this install" across reconnects
	 * and tabs. Multiple tabs on the same install publish the same
	 * `replicaId` with distinct per-socket `connId`s.
	 */
	replicaId: string;
	/**
	 * Local action registry. Pass `{}` for content docs and consume-only
	 * participants. When the registry is empty, no action runner observer is
	 * attached: pure listeners pay zero handler cost.
	 */
	actions: TActions;
};

export type Collaboration<TActions extends ActionRegistry = ActionRegistry> = {
	readonly replicaId: string;
	/**
	 * Per-socket routing address, client-minted at startup via
	 * `crypto.randomUUID()`. Stable for the lifetime of this
	 * `openCollaboration` call; a new call mints a new `connId`.
	 */
	readonly connId: string;
	readonly actions: TActions;

	readonly status: SyncStatus;
	readonly whenConnected: Promise<void>;
	readonly whenDisposed: Promise<void>;
	onStatusChange(listener: (status: SyncStatus) => void): () => void;
	reconnect(): void;

	readonly peers: PresenceSurface;

	/**
	 * Dispatch a remote call. The target is identified by `connId`; resolve
	 * one from `peers.list()`, e.g.:
	 * `peers.list().find((p) => p.replicaId === id)?.connId`.
	 * `options.signal` is required: timeout via `AbortSignal.timeout(ms)`,
	 * user cancel via `AbortController`, compose with `AbortSignal.any([...])`.
	 */
	dispatch<TInput, TOutput>(
		action: string,
		input: TInput,
		options: DispatchOptions,
	): Promise<Result<TOutput, DispatchError>>;

	/**
	 * Sugar for `ydoc.destroy()`. Both cascade to all attached primitives via
	 * the standard ydoc destroy listener. If the app owns the ydoc directly,
	 * destroying it produces the same teardown.
	 */
	[Symbol.dispose](): void;
};

// ════════════════════════════════════════════════════════════════════════════
// IMPLEMENTATION
// ════════════════════════════════════════════════════════════════════════════

export function openCollaboration<TActions extends ActionRegistry>(
	ydoc: Y.Doc,
	config: OpenCollaborationConfig<TActions>,
): Collaboration<TActions> {
	const userActions = config.actions;

	for (const key of Object.keys(userActions)) {
		if (!ACTION_KEY_PATTERN.test(key)) {
			throw new Error(
				`Invalid action key "${key}". Action keys must match ${ACTION_KEY_PATTERN.source} (snake_case ASCII, starting with a letter, max 64 chars).`,
			);
		}
	}

	const replicaId = config.replicaId;
	const connId = crypto.randomUUID();

	const rpc = new YKeyValueLww<Call>(ydoc.getArray(RPC_KEY));
	const presence = new YKeyValueLww<PresenceEntry>(ydoc.getArray(PRESENCE_KEY));

	// Wrap the user-supplied opener so every connect (including reconnects)
	// carries `?replicaId=&connId=` without callers re-encoding the URL.
	const userOpen = config.openWebSocket;
	const openWebSocket: OpenWebSocket = (rawUrl, protocols) => {
		const url = new URL(rawUrl.toString());
		url.searchParams.set('replicaId', replicaId);
		url.searchParams.set('connId', connId);
		return userOpen ? userOpen(url, protocols) : new WebSocket(url, protocols);
	};

	const supervisor = createSyncSupervisor(ydoc, {
		url: config.url,
		waitFor: config.waitFor,
		openWebSocket,
		log: config.log,
	});

	// Skip the observer entirely when there is nothing to handle. Pure
	// listeners (content docs, consume-only participants) pay zero cost.
	if (Object.keys(userActions).length > 0) {
		const detachRunner = attachActionRunner(rpc, connId, userActions);
		ydoc.once('destroy', detachRunner);
	}

	const peers = createPresenceSurface(presence, connId);

	// Client-side orphan sweep. If a previous run crashed between writing a
	// call and reaching `finally { rpc.delete(id) }`, the entry persists in
	// the workspace doc. Sweep anything older than 1h once we are online.
	void (async () => {
		try {
			await supervisor.whenConnected;
			const cutoff = Date.now() - 1000 * 60 * 60;
			for (const [id, entry] of rpc.entries()) {
				if (entry.val.sent_at < cutoff) rpc.delete(id);
			}
		} catch {
			// The supervisor rejects `whenConnected` on permanent auth failure, and
			// orphan cleanup should not surface that failure here.
		}
	})();

	return {
		replicaId,
		connId,
		actions: userActions,
		get status() {
			return supervisor.status;
		},
		whenConnected: supervisor.whenConnected,
		whenDisposed: supervisor.whenDisposed,
		onStatusChange: supervisor.onStatusChange,
		reconnect: supervisor.reconnect,
		peers,
		dispatch<TInput, TOutput>(
			action: string,
			input: TInput,
			options: DispatchOptions,
		): Promise<Result<TOutput, DispatchError>> {
			return dispatchCall<TInput, TOutput>(rpc, action, input, options);
		},
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}
