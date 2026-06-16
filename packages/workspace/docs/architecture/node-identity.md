# Node Identity

This document explains what a node is in an Epicenter network, how a node's identity is resolved, and where that identity is used.

## What Is a Node

A node is one Epicenter app running on one persistent storage scope. The storage scope is what makes two runtimes the same node or different nodes:

- Browser tabs that share the same `localStorage` (same browser, same origin) share one node.
- A separate browser, the browser extension, each Tauri window, and the CLI daemon each get a distinct node, because each has its own storage scope.

In the user-facing vocabulary, a node is a participant. Your "peers" are the other nodes you can see in a workspace.

## The Identity: `nodeId`

A node's identity is `nodeId`, a branded string (`NodeId`). It is:

- **Claimed by the client.** Only the client generates and knows its `nodeId`. The relay never assigns it; it routes by whatever the client presents.
- **Stable per install.** The id is generated once on first run and persisted, so it survives reloads and restarts.

`NodeId` is a branded type so it cannot be mixed up with other string ids (user ids, owner ids, room ids). Create it with `createNodeId` / `createNodeIdAsync`; brand a known string with `asNodeId` only at trusted call sites.

Keep `nodeId` (the string routing id) distinct from the Yjs `clientID` (a number; see [Yjs `clientID`](#yjs-clientid) below). They are different identifiers for different layers.

## How `nodeId` Is Resolved

### Browser and Extension

The browser and extension generate-or-read the id from their storage under the key `epicenter.node.id`:

- `createNodeId({ storage })` over synchronous Web Storage (`localStorage`).
- `createNodeIdAsync({ storage })` over async storage (`chrome.storage`, IndexedDB wrappers).

Both read the persisted value if present, otherwise generate a fresh id and persist it.

### CLI Daemon

The daemon uses `resolveDaemonNodeId(epicenterRoot)`, which persists the id to `.epicenter/node.json` under the Epicenter root. Properties that fall out of this:

- **One per Epicenter root.** Two folders on one machine get distinct ids, because each has its own `.epicenter/`.
- **Stable across restarts.** A restart reads the same file.
- **Machine-local.** `.epicenter/` is gitignored, so vendoring or cloning an app folder yields a fresh node on first run, which is the correct identity for a new replica.

`resolveDaemonNodeId` reuses the one `createNodeId` mechanism behind a JSON-file-backed storage, so the daemon shares the generate-once / persist semantics with the browser and extension rather than inventing a second scheme.

## Where `nodeId` Is Used

### 1. Relay Routing

The `nodeId` is stamped on the WebSocket upgrade URL as `?nodeId=` (built into the URL passed to `openCollaboration`, typically via `roomWsUrl(...)`). The relay binds the id to the socket at upgrade and stores it on the socket attachment for the lifetime of the connection; there is no round-trip validation. This bound id is the address that `dispatch({ to })` routes to. A WebSocket upgrade without a `nodeId` is rejected at the route boundary, so a connection can never become a presence-ghost (visible in presence but unreachable by dispatch).

### 2. Presence

The relay owns presence and pushes each client its peer list: the *other* nodes, excluding self. Each entry is shaped as `Peer { nodeId, connectedAt, actions }`. The relay computes the list per recipient, so a client never has to filter itself out, and it dedupes multi-tab same-node entries (newest wins by `connectedAt`).

Read presence through the collaboration handle:

```typescript
collaboration.peers.list(); // current peers (Peer[])
collaboration.peers.subscribe((peers) => {
	// called on every membership or manifest change
});
```

### 3. Seeding the Yjs `clientID`

The daemon derives a stable Yjs `clientID` from the `nodeId` via `hashYDocClientId`, pinned before any local edit. This keeps the Yjs state vector from growing one entry per restart.

## Yjs `clientID`

`clientID` is the numeric identifier Yjs stamps into every update it produces. It is distinct from `nodeId`:

| Identifier | Type   | Layer         | Source                                  |
| ---------- | ------ | ------------- | --------------------------------------- |
| `nodeId`   | string | Relay routing | Client-claimed, persisted per install   |
| `clientID` | number | Yjs CRDT      | Derived from `nodeId` via `hashYDocClientId` |

Because the daemon derives `clientID` from the install-stable `nodeId`, the `clientID` is stable too: two runs of the same node reuse the same CRDT identity and their writes merge under Yjs causality.

## Related Documentation

- [Network Topology](./network-topology.md): node types and connections
- [Action Dispatch](./action-dispatch.md): cross-node action invocation
- [Security](./security.md): network security model
