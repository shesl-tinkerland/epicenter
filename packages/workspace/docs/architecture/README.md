# Architecture Documentation

System architecture documentation for Epicenter's distributed sync system.

## Documents

| Document                                  | Description                                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| [Process Topology](./process-topology.md) | Browser tab vs. daemon vs. CLI/scripts on one machine; how the daemon is just a sync client. |
| [Network Topology](./network-topology.md) | How Y.Doc owners on different machines converge through the sync server.                     |
| [Device Identity](./device-identity.md)   | How devices identify themselves, server URLs, registry entries.                              |
| [Action Dispatch](./action-dispatch.md)   | Cross-device action invocation via YJS command mailbox.                                      |
| [Security](./security.md)                 | Security layers (Tailscale, content-addressing), threat model.                               |

The three transport docs ([Process Topology](./process-topology.md), [Network Topology](./network-topology.md), [Action Dispatch](./action-dispatch.md)) describe three orthogonal channels that compose: process topology covers same-machine IPC, network topology covers cross-machine Yjs sync, and action dispatch covers targeted cross-device RPC riding on top of sync.

## Quick Reference

> **Topology note:** Epicenter uses a two-tier architecture. Y.Doc owners (browser tabs and `epicenter serve` daemons) connect to the remote server (`apps/api`) which handles auth (Better Auth), AI streaming (`/ai/chat`), and a Yjs relay. The daemon is itself just another sync client; CLI commands and bun scripts piggyback on it via a unix socket so they do not have to own a Y.Doc. See [Process Topology](./process-topology.md) for the same-machine view and [Network Topology](./network-topology.md) for the cross-machine view. A local sidecar tier was previously planned but has been removed (see `specs/20260311T080000-remove-server-local.md`).

### Node Types

| Type          | Runtime  | Can Accept Connections | Can Serve Blobs | Notes                                           |
| ------------- | -------- | ---------------------- | --------------- | ----------------------------------------------- |
| Client (SPA)  | Browser  | No                     | No              | Data + AI → remote server                       |
| Remote Server | Bun/Node | Yes                    | No              | `apps/api`; auth, AI proxy, Yjs relay |

### Connection Rules

```
Client ──► Remote Server  ✅  (WebSocket, HTTP — data sync, AI, auth)
Client ──► Client         ✅  (via YJS action dispatch, not direct connection)
Server ──► Server         ✅  (WebSocket)
Server ──► Client         ✅  (via YJS action dispatch, not direct connection)
```

Note: Direct connections are only possible **to** servers. However, any device can invoke actions on any other device via [action dispatch](./action-dispatch.md) through the shared Y.Doc.

### Typical Setup

```
         ┌─────────┐           ┌─────────┐          ┌────────┐
         │LAPTOP A │           │LAPTOP B │          │ PHONE  │
         │ Browser │           │ Browser │          │Browser │
         └────┬────┘           └────┬────┘          └───┬────┘
              │                     │                   │
              └─────────────────────┼───────────────────┘
                                    │
                              ┌─────▼─────┐
                              │  Remote   │
                              │  Server   │
                              └───────────┘
```

## Related Documentation

- [Blob System](../blobs/README.md): How binary files sync
- [SYNC_ARCHITECTURE.md](../../SYNC_ARCHITECTURE.md): Yjs sync details
