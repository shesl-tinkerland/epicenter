# Action Dispatch

How one node invokes an action that lives on another node, using the relay as the router.

## The Problem

In an Epicenter workspace, actions run locally. But some actions are runtime-specific:

- **Browser extension**: `tabs_close`, `tabs_open`: requires the `browser.tabs.*` API
- **Desktop app (Tauri)**: `read_local_file`, `show_notification`: requires OS access
- **CLI daemon**: connects to the Y.Doc but has no browser APIs

This is not just cross-node, it's cross-runtime. A CLI daemon and a browser extension on the same machine may need to call each other's actions. The catch: a browser extension cannot accept incoming connections. It can only connect outward to the sync relay.

## The Solution: Relay-Mediated Dispatch

Both nodes are already connected to the same authorized sync room over one WebSocket. Dispatch reuses that socket. The relay, which already sees every connection, routes a call from the caller to the target and the response back.

One WebSocket carries two frame surfaces:

```
binary WS frames  ->  standard y-protocols SYNC (the CRDT data)
text WS frames    ->  presence (who is online) and dispatch (call a peer)
```

No requests table, no extra Y.Doc state, no second connection. Dispatch is a live request/response over the same socket that syncs the data. If the target is offline the call fails fast instead of being queued.

## Terminology

| Term         | Definition                                                          |
| ------------ | ------------------------------------------------------------------- |
| **Action**   | A defined `query` or `mutation` that can be invoked                  |
| **Node**     | Any runtime (browser, extension, Tauri window, CLI daemon) with a stable `nodeId` |
| **Peer**     | Another node, from the perspective of the one reading presence      |
| **Dispatch** | Calling an action on a target peer over the relay                   |

The wire carries only `nodeId`. Product-level display names live in app-owned state, never on the relay.

## Presence: Server-Owned

Presence is owned by the relay, not assembled by clients. The relay's connection map is the source of truth. On every membership or manifest change it pushes each client the full peer list as a `presence` text frame.

- The list is computed per recipient and excludes the recipient's own node, so a client never filters itself.
- Multi-tab connections for one `nodeId` are deduped (newest wins by `connectedAt`).
- There is no delta protocol: the frame IS the state. The client stores the latest list verbatim.

Each entry is a `Peer`:

```typescript
type Peer = {
	nodeId: string; // routing address for dispatch
	connectedAt: number; // for an "online since" affordance
	actions: ActionManifest; // the peer's published action manifest, or {} if none yet
};
```

A node publishes its own manifest with a `presence_publish` text frame: once on every (re)connect, and again if its local action registry changes. The relay stores the manifest against the socket and rebroadcasts presence. Manifests are opaque to the relay (stored and forwarded as bytes, never inspected), so the receiver gets each peer's action schemas with no second round trip and can render affordances or hand them to an AI tool layer directly.

Read presence through the collaboration handle:

```typescript
collaboration.peers.list(); // current peers (Peer[])
const unsubscribe = collaboration.peers.subscribe((peers) => {
	// called on every membership or manifest change
});
```

## Dispatch: Request/Response Over Text Frames

A call is one `dispatch({ to, action, input })`. The relay routes it to the most-recently-connected open socket for `to` and returns the result:

```typescript
const result = await collaboration.dispatch({
	to: targetNodeId,
	action: 'tabs_close',
	input: { tabIds: [42] },
	signal: AbortSignal.timeout(5000), // optional caller-side wait budget
});
```

Four frames cross the relay for one call:

```
Caller                  Relay                   Target peer
  │                       │                          │
  │  dispatch_request     │                          │
  │  { id, to, action }   │                          │
  │──────────────────────>│  pick newest open        │
  │                       │  socket for `to`         │
  │                       │  dispatch_inbound        │
  │                       │─────────────────────────>│
  │                       │                   run action locally
  │                       │  dispatch_response       │
  │                       │<─────────────────────────│
  │  dispatch_result      │                          │
  │<──────────────────────│                          │
  │  resolve / reject      │                          │
```

The target decides whether the action exists: the relay never inspects action names, it only routes by `nodeId` within the already authorized room. Identity is the `nodeId` bound to each socket at WebSocket upgrade (see [Node Identity](./node-identity.md)); there is no server-stamped connection id on the wire.

### Offline and Timeout

If the relay has no live socket for `to`, it answers the caller immediately with `RecipientOffline` rather than queuing anything. A bounded timer guards the in-flight case: if the recipient never replies, the relay answers `RecipientOffline` so the caller's promise always settles. The optional `signal` is the caller-side wait budget; the relay enforces its own ceiling independently.

There is no stale-request hazard to design around: dispatch is live, so a node that was offline never wakes up to a backlog of old calls. The failure mode is a fast `RecipientOffline`, not a surprise execution.

## Where This Runs

- **In an app (browser, extension, Tauri):** `openCollaboration(...)` returns the `collaboration` handle with `peers` and `dispatch` above.
- **On the CLI daemon:** the same handle is surfaced as two commands. `epicenter peers` prints `collaboration.peers.list()`; `epicenter run <mount>.<action> --peer <nodeId>` calls `collaboration.dispatch(...)`. A peer that is not reachable surfaces as `PeerNotFound` (the daemon's name for `RecipientOffline`).

## Related Documentation

- [Node Identity](./node-identity.md): what a node is and how `nodeId` is resolved and routed
- [Network Topology](./network-topology.md): connection patterns
- [SYNC_ARCHITECTURE.md](../../SYNC_ARCHITECTURE.md): multi-node sync details
- [Security](./security.md): network security model
