/**
 * Bind a unix socket carrying length-prefixed Yjs sync sessions.
 *
 * Replaces the Hono-based daemon transport. Each connection sends a JSON
 * preamble as its first frame (`{ workspace, deviceId, clientId, isEphemeral,
 * schemaManifest? }`); the listener parses that, looks up the matching
 * `IpcSyncServer`, replies with a serialized wellcrafted `Result` envelope,
 * then hands the channel to the matched server's `acceptSession`.
 *
 * Wire shape inside frames after preamble: `MESSAGE_TYPE.SYNC` and
 * `MESSAGE_TYPE.AWARENESS` only. There is no `kind` discriminator and no
 * second mode: every connection is a sync session against one of the
 * daemon's hosted workspaces.
 *
 * Per-connection state is stored on `socket.data` (Bun's typed first-class
 * slot), not via property-mutation tricks. Hono is deliberately not
 * involved: its model is `Request -> Response`, which has no place to
 * attach the raw byte-stream framer this transport needs.
 *
 * This module deliberately does NOT touch `server.ts` yet. It is the
 * primitive commit 7 will wire in once the JSON-RPC transport has been
 * deleted in the same change.
 */

import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Err, Ok, type Result } from 'wellcrafted/result';

import type { IpcChannel, IpcPreamble, IpcSyncServer } from './sync-hub.js';
import {
	createFrameReader,
	encodeFrame,
} from '../shared/ipc-framing.js';

// ============================================================================
// Errors
// ============================================================================

/**
 * The handshake outcomes the listener can surface to a connecting peer. The
 * full error object travels on the wire inside the `error` field of the
 * preamble-reply envelope, so the client narrows on `error.name` (not on
 * a separate `_tag` field).
 */
export const IpcHandshakeError = defineErrors({
	/** Preamble bytes did not parse as JSON. */
	BadPreamble: ({ reason }: { reason: string }) => ({
		message: `[bindIpcSocket] preamble invalid: ${reason}`,
		reason,
	}),
	/** Preamble JSON parsed but is missing required fields. */
	PreambleSchemaMismatch: ({ reason }: { reason: string }) => ({
		message: `[bindIpcSocket] preamble schema mismatch: ${reason}`,
		reason,
	}),
	/** No `IpcSyncServer` registered for the requested workspace selector. */
	NoSuchWorkspace: ({ workspace }: { workspace: string }) => ({
		message: `[bindIpcSocket] unknown workspace: ${workspace}`,
		workspace,
	}),
});
export type IpcHandshakeError = InferErrors<typeof IpcHandshakeError>;

export const IpcListenerError = defineErrors({
	BindFailed: ({ cause }: { cause: unknown }) => ({
		message: `[bindIpcSocket] bind failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type IpcListenerError = InferErrors<typeof IpcListenerError>;

// ============================================================================
// Wire envelope
// ============================================================================

/**
 * Reply envelope written back as the second frame of the handshake. This is
 * literally a serialized wellcrafted `Result<IpcPreambleReply, IpcHandshakeError>`,
 * so the client's deserializer has no translation step: it parses the JSON
 * into `{ data, error }` and uses `error?.name` to discriminate variants.
 */
export type IpcPreambleReplyEnvelope = Result<
	IpcPreambleReply,
	IpcHandshakeError
>;

export type IpcPreambleReply = {
	workspaceGuid?: string;
};

export type IpcListener = {
	readonly socketPath: string;
	close(): Promise<void>;
	whenDisposed: Promise<void>;
};

// ============================================================================
// Per-connection state, stored in Bun's typed `socket.data` slot
// ============================================================================

type ConnectionState = {
	/** Length-prefix frame reader. Returns `false` until the preamble lands. */
	readonly feed: (chunk: Uint8Array) => void;
	/** Channel handed to `IpcSyncServer.acceptSession` once preamble succeeds. */
	readonly channel: IpcChannel;
	/** Trigger the channel's onClose listeners. Idempotent. */
	readonly fireClose: () => void;
};

type BunIpcSocket = {
	data: ConnectionState;
	write(data: Uint8Array): number | void;
	end(): void;
};

// ============================================================================
// Bind
// ============================================================================

export async function bindIpcSocket(opts: {
	socketPath: string;
	/** Map of workspace selector to its `attachIpcSyncServer`. */
	servers: Map<string, IpcSyncServer>;
	log?: Logger;
}): Promise<IpcListener> {
	const log = opts.log ?? createLogger('bindIpcSocket');
	const { socketPath, servers } = opts;

	mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });

	const activeChannels = new Set<IpcChannel>();

	// biome-ignore lint/suspicious/noExplicitAny: Bun.listen unix-socket types vary across versions
	const listener = (Bun as any).listen({
		unix: socketPath,
		socket: {
			open(socket: BunIpcSocket) {
				const state = createConnectionState(socket, servers, log);
				socket.data = state;
				activeChannels.add(state.channel);
				state.channel.onClose(() => activeChannels.delete(state.channel));
			},
			data(socket: BunIpcSocket, chunk: Uint8Array) {
				socket.data.feed(chunk);
			},
			close(socket: BunIpcSocket) {
				socket.data?.fireClose();
			},
			end(socket: BunIpcSocket) {
				socket.data?.fireClose();
			},
			error(socket: BunIpcSocket, _err: Error) {
				socket.data?.fireClose();
			},
		},
	});

	chmodSync(socketPath, 0o600);

	let stopped = false;
	const { promise: whenDisposed, resolve: resolveDisposed } =
		Promise.withResolvers<void>();

	return {
		socketPath,
		async close() {
			if (stopped) {
				await whenDisposed;
				return;
			}
			stopped = true;
			for (const ch of Array.from(activeChannels)) ch.close();
			activeChannels.clear();
			try {
				listener?.stop?.();
			} catch (cause) {
				log.warn(IpcListenerError.BindFailed({ cause }));
			}
			resolveDisposed();
		},
		whenDisposed,
	};
}

// ============================================================================
// Per-connection driver
// ============================================================================

function createConnectionState(
	socket: BunIpcSocket,
	servers: Map<string, IpcSyncServer>,
	log: Logger,
): ConnectionState {
	let preambleConsumed = false;
	let closed = false;
	const frameListeners = new Set<(b: Uint8Array) => void>();
	const closeListeners = new Set<() => void>();

	function fireClose() {
		if (closed) return;
		closed = true;
		for (const cb of closeListeners) cb();
	}

	const channel: IpcChannel = {
		sendFrame(bytes) {
			if (closed) return;
			try {
				socket.write(encodeFrame(bytes));
			} catch {
				fireClose();
			}
		},
		onFrame(cb) {
			frameListeners.add(cb);
			return () => frameListeners.delete(cb);
		},
		close() {
			if (closed) return;
			try {
				socket.end();
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

	const reader = createFrameReader((frame) => {
		if (!preambleConsumed) {
			preambleConsumed = true;
			handlePreambleFrame(frame, socket, servers, channel, log);
			return;
		}
		for (const cb of frameListeners) cb(frame);
	});

	return {
		feed(chunk) {
			reader.push(chunk);
		},
		channel,
		fireClose,
	};
}

function writeReplyEnvelope(
	socket: BunIpcSocket,
	envelope: IpcPreambleReplyEnvelope,
) {
	const json = JSON.stringify(envelope);
	const payload = new TextEncoder().encode(json);
	socket.write(encodeFrame(payload));
}

function handlePreambleFrame(
	frame: Uint8Array,
	socket: BunIpcSocket,
	servers: Map<string, IpcSyncServer>,
	channel: IpcChannel,
	log: Logger,
) {
	const text = new TextDecoder().decode(frame);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (cause) {
		writeReplyEnvelope(
			socket,
			Err(
				IpcHandshakeError.BadPreamble({
					reason: extractErrorMessage(cause),
				}).error,
			),
		);
		channel.close();
		return;
	}

	const validated = validatePreamble(parsed);
	if (validated.error !== null) {
		writeReplyEnvelope(socket, validated);
		channel.close();
		return;
	}

	const preamble = validated.data;
	const server = servers.get(preamble.workspace);
	if (!server) {
		writeReplyEnvelope(
			socket,
			Err(
				IpcHandshakeError.NoSuchWorkspace({
					workspace: preamble.workspace,
				}).error,
			),
		);
		channel.close();
		return;
	}

	writeReplyEnvelope(
		socket,
		Ok({ workspaceGuid: preamble.workspace }),
	);

	void server
		.acceptSession({ channel, preamble })
		.catch((cause) => {
			log.warn(IpcListenerError.BindFailed({ cause }));
			channel.close();
		});
}

function validatePreamble(
	parsed: unknown,
): Result<IpcPreamble, IpcHandshakeError> {
	if (parsed === null || typeof parsed !== 'object') {
		return Err(
			IpcHandshakeError.PreambleSchemaMismatch({
				reason: 'preamble was not a JSON object',
			}).error,
		);
	}
	const p = parsed as Record<string, unknown>;
	if (typeof p.workspace !== 'string') {
		return Err(
			IpcHandshakeError.PreambleSchemaMismatch({
				reason: 'missing required field "workspace" (string)',
			}).error,
		);
	}
	if (typeof p.deviceId !== 'string') {
		return Err(
			IpcHandshakeError.PreambleSchemaMismatch({
				reason: 'missing required field "deviceId" (string)',
			}).error,
		);
	}
	if (typeof p.clientId !== 'number') {
		return Err(
			IpcHandshakeError.PreambleSchemaMismatch({
				reason: 'missing required field "clientId" (number)',
			}).error,
		);
	}
	return Ok({
		workspace: p.workspace,
		deviceId: p.deviceId,
		clientId: p.clientId,
		isEphemeral: typeof p.isEphemeral === 'boolean' ? p.isEphemeral : true,
		schemaManifest:
			typeof p.schemaManifest === 'object' && p.schemaManifest !== null
				? (p.schemaManifest as Record<string, string>)
				: undefined,
	});
}
