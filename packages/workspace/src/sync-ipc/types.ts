/**
 * Cross-cutting types for the IPC sync transport.
 *
 * These shapes are spoken by all three modules in this folder (server,
 * client, listener) plus their tests. Co-locating them here keeps the
 * client from reaching into the server module just for a duplex-channel
 * type, and keeps the wire vocabulary in one place.
 */

/**
 * JSON preamble sent by the peer as the first frame of a connection. The
 * listener parses and validates the bytes; the server's `acceptSession`
 * receives it as a structured object.
 */
export type IpcPreamble = {
	/** Workspace selector (matches an `attachIpcSyncServer.workspace` value). */
	workspace: string;
	/** Stable per-device identifier. Cross-device addressing concern. */
	deviceId: string;
	/** Yjs clientID hint. Mandatory for ephemeral peers (state-vector hygiene). */
	clientId: number;
	/** True for one-shot script peers; false for long-running peers (browsers, sidecars). */
	isEphemeral: boolean;
	/** Optional: peer's per-table schema fingerprints for handshake validation. */
	schemaManifest?: Record<string, string>;
};

/**
 * Server's response to the peer's preamble. Carried as the second frame of
 * the handshake inside a serialized wellcrafted Result envelope.
 *
 * `encryptionKeys` is populated by `bindIpcSocket` for workspaces that have
 * an attached encryption coordinator; the peer-side `attachIpcSyncClient`
 * forwards them to `opts.onPreambleReply` so callers can seed their keyring
 * before any sync frame is processed. Other fields are forward-compat
 * placeholders the listener does not yet populate.
 */
export type IpcPreambleReply = {
	workspaceGuid?: string;
	encryptionKeys?: unknown;
	serverClientId?: number;
	daemonManifest?: Record<string, string>;
};

/**
 * Bidirectional framed-message channel. The listener wraps a `Bun.Socket`
 * with framing for production; tests pass an in-memory pair. Frames are
 * fully-formed Yjs/awareness messages (the JSON preamble is consumed by
 * the listener before `acceptSession` is called).
 */
export type IpcChannel = {
	/** Send one frame to the remote side. */
	sendFrame: (bytes: Uint8Array) => void;
	/** Subscribe to inbound frames. Returns an unsubscribe function. */
	onFrame: (cb: (bytes: Uint8Array) => void) => () => void;
	/** Initiate channel close. Implementations should be idempotent. */
	close: () => void;
	/** Subscribe to channel-close. Fires exactly once per channel lifetime. */
	onClose: (cb: () => void) => () => void;
};
