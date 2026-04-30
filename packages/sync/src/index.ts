/**
 * `@epicenter/sync`: Yjs Sync Protocol Primitives + Typed RPC Surface
 *
 * Encode/decode functions for the y-websocket wire protocol, RPC error
 * variants shared by server and client, and the typed action / peer
 * dispatch primitives that consumers compose into a workspace's wire API.
 *
 * For server-side WebSocket lifecycle handlers, import from
 * `@epicenter/sync/server` instead.
 */

// Typed action definitions and the action-tree walker / wire form.
export type {
	Action,
	ActionFailed,
	ActionManifest,
	ActionMeta,
	Actions,
	Mutation,
	Query,
	RemoteActions,
	RemoteCallOptions,
	SystemActions,
	WrapAction,
} from './actions';
export {
	defineMutation,
	defineQuery,
	describeActions,
	invokeAction,
	isAction,
	isMutation,
	isQuery,
	resolveActionPath,
	walkActions,
} from './actions';

// Typed RPC map utilities for end-to-end-typed `rpc<TMap>()` call sites.
export type { DefaultRpcMap, InferRpcMap, RpcActionMap } from './rpc-types';

// Peer dispatch (cross-device action calling). `peer<T>(transport, deviceId)`
// returns a proxy whose method calls dispatch via the transport's `rpc`. Any
// `PeerTransport`-shaped object works; the typical caller passes
// `workspace.sync` directly.
export type { PeerTransport } from './peer';
export { describePeer, peer } from './peer';

// Protocol (encode/decode for WS messages and HTTP sync requests)
export {
	type DecodedRpcMessage,
	decodeMessageType,
	decodeRpcMessage,
	decodeRpcPayload,
	decodeSyncMessage,
	decodeSyncRequest,
	decodeSyncStatus,
	encodeAwareness,
	encodeAwarenessStates,
	encodeQueryAwareness,
	encodeRpcRequest,
	encodeRpcResponse,
	encodeSyncRequest,
	encodeSyncStatus,
	encodeSyncStep1,
	encodeSyncStep2,
	encodeSyncUpdate,
	handleSyncPayload,
	MESSAGE_TYPE,
	RPC_TYPE,
	SYNC_MESSAGE_TYPE,
	type SyncMessageType,
	stateVectorsEqual,
} from './protocol';

// RPC error variants and type guard (used by both server and client)
export { isRpcError, RpcError } from './rpc-errors';

// Transport origin sentinels (shared across all sync layers)
export { BC_ORIGIN, SYNC_ORIGIN } from './origins';

// WebSocket subprotocol auth (shared client/server constants + helpers)
export {
	BEARER_SUBPROTOCOL_PREFIX,
	MAIN_SUBPROTOCOL,
	extractBearerToken,
	parseSubprotocols,
} from './auth-subprotocol';
