# Multi-Node Sync Architecture

Epicenter replicates a `Y.Doc` across many nodes over a WebSocket relay. Yjs's CRDT semantics keep every replica eventually consistent regardless of message order or how many nodes are connected. The relay is a dumb pipe: it moves bytes, never executes business logic.

This document describes the runtime: the one public primitive (`openCollaboration`), the handle it returns, and how the wire is organized.

## One primitive: `openCollaboration`

Every document that participates in sync, the workspace doc and every nested content doc, goes through `openCollaboration`. There is no second primitive. The workspace doc passes a real action registry; content docs pass `actions: {}`.

```ts
import {
    defineActions,
    defineMutation,
    openCollaboration,
    roomWsUrl,
} from '@epicenter/workspace';

const collaboration = openCollaboration(ydoc, {
    url: roomWsUrl({ baseURL, ownerId, guid: ydoc.guid, nodeId }),
    waitFor: idb.whenLoaded,
    openWebSocket: auth.openWebSocket,
    onReconnectSignal: auth.onStateChange,
    actions: defineActions({
        tabs_close: defineMutation({ /* ... */ }),
    }),
});

// Local invocation: direct function call against the registry.
await collaboration.actions.tabs_close({ tabIds: [1, 2] });

// Remote invocation: pick an online peer, dispatch to it over the relay.
const phone = collaboration.peers
    .list()
    .find((peer) => peer.nodeId === 'phone');
if (phone) {
    const { data, error } = await collaboration.dispatch({
        to: phone.nodeId,
        action: 'tabs_close',
        input: { tabIds: [1, 2] },
        signal: AbortSignal.timeout(5_000),
    });
}
```

Content docs (rich-text bodies, attachments, anything nested that syncs independently) use the same call with `actions: {}`. Inbound dispatch frames reply `ActionNotFound`; sync and presence are unchanged.

## The `Collaboration` handle

`openCollaboration` returns synchronously:

| Field             | What it is                                                         |
| ----------------- | ------------------------------------------------------------------ |
| `actions`         | Live local action registry; call directly                          |
| `status`          | Current `SyncStatus` (`offline`/`connecting`/`connected`/`failed`) |
| `whenConnected`   | Resolves on first successful handshake; rejects on permanent fail  |
| `whenDisposed`    | Resolves once the supervisor exits and the socket closes           |
| `onStatusChange`  | Subscribe to status changes; returns unsubscribe                   |
| `reconnect`       | Manually wake the supervisor (resets backoff)                      |
| `peers`         | `list()` / `subscribe()` over the server-owned presence channel    |
| `dispatch`        | Fire a cross-node call over the relay socket                     |
| `[Symbol.dispose]`| Sugar for `ydoc.destroy()`; cascades through every attachment      |

`peers.list()` returns `Peer[]`, where each peer carries `{ nodeId, connectedAt, actions }`. `actions` is the peer's published `ActionManifest` (the metadata-only projection of its `ActionRegistry`), suitable for rendering UI affordances, validating input against schemas, or feeding an AI tool layer.

## The wire: one socket, three channels

`openCollaboration` opens exactly one authenticated WebSocket per `(Y.Doc, relay)` pair. Three channels share that socket:

```
binary frames   ->  Yjs CRDT sync (STEP1 / STEP2 / UPDATE)
text frames     ->  presence + dispatch
```

Channels are independent: a malformed dispatch frame does not tear down sync. The server NEVER inspects the contents of a Yjs binary frame or a dispatch input; it only routes and persists.

### Sync plane (binary)

Standard Yjs sync: STEP1 (state vector), STEP2 (missing updates), UPDATE (incremental changes). The supervisor encodes and decodes through `@epicenter/sync`'s `handleSyncPayload`. The first STEP2 or UPDATE after connect completes the handshake and flips status to `connected`.

The server merges every update it sees (Yjs is multi-writer; admission control is not the server's job here) and fans out to peers excluding origin. The update log persists to per-room storage and is opportunistically compacted when the room empties.

### Presence plane (server-owned)

The relay tracks live WebSocket connections in a `connections` Map. That map is the source of truth for "who is here." On every membership or manifest change it broadcasts one server-to-client text frame carrying the whole list:

```ts
type PresenceFrame = {
    type: 'presence';
    peers: Peer[];
};

type Peer = {
    nodeId: string;
    connectedAt: number;
    actions: ActionManifest;   // Record<string, ActionMeta>
};
```

- The frame is sent to a freshly-upgraded socket, and rebroadcast to every other socket whenever a peer joins, leaves, or republishes its manifest.
- `peers` is computed per recipient with the receiver's own install excluded, so the client stores it verbatim.
- Multi-tab same-install collapses to one row (newest-wins by `connectedAt`); a graceful tab handoff produces no wire-visible transition (300 ms debounce).
- A close code of `4401` (permanent auth failure) bypasses the debounce: the dropped peer disappears from everyone else's list immediately.

There is no delta protocol. The relay owns the whole truth and ships the whole truth on every change; the client never reassembles `added` / `removed` events.

Nodes publish their own manifest with one client-to-server frame on every (re)connect:

```ts
type PresencePublishFrame = {
    type: 'presence_publish';
    actions: ActionManifest;
};
```

The relay stores the manifest against the sending socket's connection attachment (so it survives Cloudflare hibernation via `serializeAttachment`) and rebroadcasts presence so peers see the update.

`openCollaboration` builds its own manifest from the action registry via `toActionMeta` at construction and publishes it on every successful connect.

#### Why server-owned, not awareness

Presence used to ride y-protocols Awareness. Awareness is built for ephemeral peer-to-peer state with concurrent per-peer writers (cursors, selections, typing indicators), not for a server-authoritative fact the relay already holds in its `connections` Map. Moving presence onto a plain server-pushed channel deleted the awareness round-trip, the Durable Object hibernation restore loop, and the clock-fabrication seed.

Cursor and selection sync, when they arrive, bring Awareness back, used for what it is designed for and kept separate from this presence channel.

### Dispatch plane (text, in-band)

A cross-node call rides text frames on the same socket as presence and sync. The wire is four correlated frames:

```ts
caller -> relay:     { type: 'dispatch_request',  id, to, action, input }
relay  -> recipient: { type: 'dispatch_inbound',  id, action, input }
recipient -> relay:  { type: 'dispatch_response', id, result }
relay  -> caller:    { type: 'dispatch_result',   id, result }
```

```ts
const { data, error } = await collaboration.dispatch({
    to: 'phone-install-id',
    action: 'tabs_close',
    input: { tabIds: [1, 2] },
    signal: AbortSignal.timeout(5_000),
});
```

End to end:

```
caller                      relay                        recipient
──────                      ─────                        ─────────
dispatch_request ─────────▶ look up `to` in connections
                            │
                            ├─ no live socket ─▶ dispatch_result { RecipientOffline }
                            │
                            └─ dispatch_inbound ──▶ runInboundDispatch:
                                                      actions[action](input)
                                                      │
                            ◀── dispatch_response ────┘
       dispatch_result ◀──  forward opaquely
       { Ok(data) }
       or { Err(...) }
```

The caller's `signal` (or a ~90 s caller-side ceiling) settles the promise if no result arrives. The relay holds its own internal 60 s timeout so a stuck dispatch eventually answers `RecipientOffline`.

`dispatch` always resolves to `Result<unknown, DispatchError>`:

| Variant            | Produced by | When                                                       |
| ------------------ | ----------- | ---------------------------------------------------------- |
| `RecipientOffline` | relay       | No live socket for `to`, or its socket closed mid-handler  |
| `ActionNotFound`   | recipient   | Recipient has no handler for `action`                      |
| `ActionFailed`     | recipient   | Recipient handler threw or returned `Err`; `cause` is a string |
| `Cancelled`        | local       | Caller's `AbortSignal` aborted before the response arrived |
| `NetworkFailed`    | local       | Dispatch socket disconnected, dropped, or returned a malformed result |

`RecipientOffline`, `ActionNotFound`, and `ActionFailed` arrive in `dispatch_result` frames. `Cancelled` and `NetworkFailed` are produced locally.

Because the relay answers reachability inline (its `connections` Map decides, on the same socket that routes the call), callers that need to tell "addressed an offline install" apart from "the call reached the peer and failed" branch on `RecipientOffline` directly. There is no separate liveness pre-check, and no window where a client cache disagrees with the relay.

`dispatch` returns `Result<unknown, DispatchError>`; the caller narrows the success payload against the shape the target action returns:

```ts
const { data } = await collaboration.dispatch({
    to: phone.nodeId,
    action: 'tabs_close',
    input: { tabIds: [1, 2] },
});
const closed = data as { tabIds: number[] };
```

With manifests on the presence wire, that narrowing is *runtime-verifiable*: walk `node.actions` and confirm the action key exists before dispatching. The wire payload is the ground truth.

The recipient side is `runInboundDispatch`: the supervisor routes inbound text frames to it, it looks up the action in the local registry, runs it, and emits the `dispatch_response`. A content doc with `actions: {}` always replies `ActionNotFound`.

## URLs and routing

A cloud document is owned by the authenticated `OwnerId` and addressed by its own `ydoc.guid`. The client builds the URL from `(baseURL, ownerId, guid, nodeId)`:

```ts
roomWsUrl({
    baseURL: 'https://api.epicenter.so',
    ownerId,
    guid: ydoc.guid,
    nodeId,
});
// -> wss://api.epicenter.so/api/owners/<ownerId>/rooms/<guid>?nodeId=<id>
```

In personal mode `ownerId` equals the signed-in user's id; in shared mode it is
the literal `'shared'`. The URL shape is uniform across both modes. The relay
takes the user from the auth token, resolves the expected owner partition for
the deployment, verifies the URL `:ownerId` matches that partition, and builds
the internal Durable Object name `owners/${ownerId}/rooms/${room}`. Personal
deployments resolve one partition per user. Shared-wiki deployments resolve one
shared partition for admitted users.

This is the consumer Google Docs model and the first of three account layers, introduced over time:

- **Layer 1 (this)**: personal content. `owners/${ownerId}` owns the doc, where `ownerId === userId`.
- **Layer 1.5 (future)**: sharing. A per-document ACL grants other users access; the owner's DO name does not change.
- **Layer 2 (future)**: shared-drive content. A shared-wiki deployment uses `ownerId === 'shared'` so content survives a departing user.
- **Layer 3 (future)**: tenancy and billing. An organization groups user accounts for one invoice and admin policy; it never owns a document.

`nodeId` is appended as a query parameter (`?nodeId=`) on every connect, including reconnects. It is a routing label stamped on the socket at upgrade, not an auth principal: the relay authorizes the room from the token, and within that room `nodeId` only decides which socket dispatch is delivered to.

`/owners/:ownerId/rooms/:room` is the single cloud sync route shape (personal: `:ownerId` is the user id; shared: `:ownerId === 'shared'`). Browser apps and the workspace daemon both build their URL with `roomWsUrl`.

## Supervisor lifecycle

`openCollaboration` wraps an internal `createSyncSupervisor` that owns the WebSocket. Three timers participate:

| Timer                 | Default | Job                                                         |
| --------------------- | ------- | ----------------------------------------------------------- |
| `CONNECT_TIMEOUT_MS`  | 15 s    | Abort a socket stuck in CONNECTING                          |
| `PING_INTERVAL_MS`    | 60 s    | Send a `'ping'` text frame to keep the socket alive         |
| `LIVENESS_TIMEOUT_MS` | 90 s    | Close the socket if no traffic arrives for this long (checked every 10 s) |

### Connect, reconnect, backoff

```
   ┌─────────────┐
   │   offline   │ ◄── ydoc.destroy()
   └──────┬──────┘
          │ waitFor resolves
          ▼
   ┌─────────────┐
   │ connecting  │ ──► attemptConnection(signal)
   │ retries=N   │ ◄── reconnect() wakes the loop
   └──────┬──────┘
          │ STEP2/UPDATE handshake
          ▼
   ┌─────────────┐
   │  connected  │ ──► whenConnected.resolve()
   │             │ ──► presence_publish sent
   └──────┬──────┘
          │ ws.onclose
          ▼
   backoff sleep (jittered, capped at 30 s)
          │
          └─► retry
```

Backoff is `min(BASE_DELAY_MS * 2 ** retries, MAX_DELAY_MS)` scaled by `0.5 + Math.random() * 0.5`. Window `online`, `offline`, and `visibilitychange` events wake the backoff or close the socket as appropriate.

### Permanent failure

A server-side auth rejection closes the WebSocket with code `4401` and a JSON reason `{ "code": "<reason>" }`. Codes seen today: `invalid_token`, `token_expired`, `deauthorized`, `unknown`. On 4401:

- Status becomes `{ phase: 'failed', reason: { type: 'auth', code } }`.
- `whenConnected` rejects with `SyncFailedError.AuthRejected({ code })`.
- The supervisor parks; only `reconnect()` reopens it. Apps wire `reconnect()` to `auth.onStateChange` so a sign-in retries automatically.

### Cancellation hierarchy

```
masterController   aborts on ydoc.destroy(); kills everything
   ▼
cycleController    aborts on reconnect(); kills the current iteration only
```

`reconnect()` replaces `cycleController` (rather than just re-aborting it) so the next cycle gets a fresh signal unrelated to the old one. The supervisor reads `cycleController.signal` fresh at the top of each iteration; aborting the old one wakes a parked supervisor and the next iteration picks up the replacement.

## Mental model in one paragraph

`openCollaboration(ydoc, config)` is the one collaboration primitive: it opens a single WebSocket to the relay, runs the Yjs binary sync protocol, publishes its own action manifest at connect via `presence_publish`, mirrors the relay's server-owned presence channel into `peers` (including each peer's manifest), and runs inbound dispatch frames against the local `actions` registry. Cross-node calls go out through `dispatch(...)`, which rides the same socket as text frames and answers with a typed `Result<unknown, DispatchError>`. The relay is a dumb pipe: it merges Yjs updates (eventually consistent CRDT semantics, no admission control), tracks the live connections Map (source of truth for who is here), and forwards dispatch text frames (it never executes them). Presence is the relay's `connections` Map, not Yjs Awareness; dispatch is in-band text on the sync socket, not HTTP. Content docs use the same primitive with `actions: {}`.
