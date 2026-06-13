# Action Dispatch

> **Note**: "Suspended" terminology was renamed to "saved" in the codebase. References below use the original names. See `specs/20260213T014300-rename-suspended-to-saved.md`.

How to invoke actions across runtimes using YJS as the transport layer.

## The Problem

In an Epicenter workspace, actions run locally. But some actions are runtime-specific:

- **Browser extension**: `closeTab`, `openTab`: requires `browser.tabs.*` API
- **Desktop app (Tauri)**: `readLocalFile`, `showNotification`: requires OS access
- **CLI**: Can connect to the Y.Doc but has no browser APIs

This is not just cross-device: it's cross-runtime. A CLI tool and a browser extension on the same machine need to communicate. The challenge: the browser extension can't accept incoming connections. It can only connect outward to sync servers.

## The Solution: Requests Table

Use the Y.Doc itself as a message bus. Since all clients already sync via Yjs, add a `requests` table to the workspace. Any client can write a request targeting a specific device, and that device processes it.

```
┌─────────────────────────────────────────────────────────────┐
│ Y.Doc Root                                                   │
│                                                              │
│   tables/              <- Existing data                      │
│   ├── posts                                                  │
│   └── users                                                  │
│                                                              │
│   requests/            <- Action dispatch (per-workspace)    │
│   └── { requestId -> Request }                               │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

No new connections needed. The same sync providers that replicate your data also handle dispatch.

## Terminology

| Term        | Definition                                                  |
| ----------- | ----------------------------------------------------------- |
| **Action**  | A defined operation (query or mutation) that can be invoked |
| **Request** | A request to invoke an action on a target device            |
| **Device**  | Any runtime (browser, server, CLI) with a stable `deviceId` |

Actions are what you define. Requests are how you invoke them remotely.

## Three Concerns, Three Mechanisms

| Concern                                 | Mechanism                   | Why                                     |
| --------------------------------------- | --------------------------- | --------------------------------------- |
| **Discovery** (what can a device do?)   | Static workspace definition | Serializable JSON, loaded at build time |
| **Presence** (who is online right now?) | Awareness protocol          | Ephemeral, auto-cleanup on disconnect   |
| **Dispatch** (do this on that device)   | Requests table              | Durable within TTL, request/response    |

### Awareness: Identity Only

Awareness carries the minimum needed for presence detection:

```typescript
awareness.setLocalState({
	deviceId,
	type: 'browser-extension', // or 'desktop', 'server', 'cli'
});
```

No action schemas, no capabilities. Just identity and device type.

**Why not put action schemas in awareness?**

- Awareness uses `JSON.stringify(fullState)` per update: no delta encoding
- Every heartbeat (15s) re-sends the full payload
- Action schemas are static: they don't change at runtime
- Workspace definitions already provide this information

### Action Discovery: Static Definitions

Workspace definitions are already serializable JSON. Any client that imports the definition knows what actions exist and their input schemas. For runtime introspection (a generic tool that doesn't import the definition), serialize the definition to JSON and fetch it once.

## Request Shape

Flat and generic. State is derived from timestamps, not stored as an enum:

```typescript
type Request = {
	id: string;
	targetDeviceId: string;
	action: string;
	input: unknown;
	createdAt: number;
	expiresAt: number;
	respondedAt: number | null;
	output: unknown | null;
};
```

**State is derived:**

- **Pending**: `respondedAt === null && Date.now() < expiresAt`
- **Responded**: `respondedAt !== null`
- **Expired**: `respondedAt === null && Date.now() >= expiresAt`

No `status` enum needed. Two timestamps tell the full story.

## Stale Request Protection

The critical safety requirement: a device that reconnects after being offline must NOT execute old requests. No surprise tab closures.

**Layer 1: Awareness gate (pre-dispatch)**

Before writing a request, check awareness. If the target isn't online, reject immediately. Don't write the request.

```typescript
const states = awareness.getStates();
const targetOnline = [...states.values()].some(
	(s) => s.deviceId === targetDeviceId,
);

if (!targetOnline) {
	return { error: { message: 'Target device is offline' } };
}
```

**Layer 2: TTL (post-dispatch safety net)**

Every request has an `expiresAt` (default: 30 seconds). The target device skips anything past expiry.

```typescript
if (Date.now() > request.expiresAt) {
	requestsTable.update({
		id: request.id,
		respondedAt: Date.now(),
		output: { error: 'expired' },
	});
	continue;
}
```

Together: the awareness gate prevents writing requests to offline devices, and the TTL prevents execution if the device went offline after the request was written.

## Device Identity

Every device needs a stable identity for request routing.

### Browsers / Extensions

Generate a persistent UUID on first load:

```typescript
function getDeviceId(): string {
	let id = localStorage.getItem('epicenter-device-id');
	if (!id) {
		id = crypto.randomUUID();
		localStorage.setItem('epicenter-device-id', id);
	}
	return id;
}
```

### Servers

Use Tailscale identity if available, otherwise fall back to hostname:

```typescript
import os from 'os';
import { $ } from 'bun';

async function getServerDeviceId(): Promise<string> {
	if (process.env.EPICENTER_DEVICE_ID) {
		return process.env.EPICENTER_DEVICE_ID;
	}

	const { stdout, exitCode } = await $`tailscale status --json`
		.nothrow()
		.quiet();

	if (exitCode === 0) {
		const parsed = JSON.parse(stdout.toString());
		const tailscaleId = parsed.Self?.ID;
		if (tailscaleId) {
			return `tailscale-${tailscaleId}`;
		}
	}

	return `server-${os.hostname()}`;
}
```

## Request Flow

```
Sender                          Target Device
   │                                    │
   │ 0. Check awareness: is target online?
   │    If not -> fail immediately      │
   │                                    │
   │ 1. Write request                   │
   │    respondedAt: null               │
   │    expiresAt: now + 30s            │
   │─────────────YJS sync──────────────>│
   │                                    │
   │                            2. Observe new request
   │                               targetDeviceId === myDeviceId? Y
   │                               Expired? N
   │                                    │
   │                            3. Execute action locally
   │                                    │
   │                            4. Write response
   │                               respondedAt: Date.now()
   │                               output: { data: {...} }
   │<─────────────YJS sync─────────────│
   │                                    │
   │ 5. Observe response                │
   │    respondedAt !== null            │
   │    Resolve promise with output     │
   │                                    │
```

Since requests are explicitly targeted and we check awareness first, there's no race condition: only one device will ever process each request.

## Cleanup

Responded and expired requests accumulate in the Y.Doc. Purge periodically:

```typescript
function purgeRequests(requestsTable) {
	const RETENTION = 5 * 60 * 1000; // 5 minutes
	const now = Date.now();

	for (const req of requestsTable.scan().rows) {
		if (req.respondedAt !== null && now - req.respondedAt > RETENTION) {
			requestsTable.delete({ id: req.id });
		}
		if (req.respondedAt === null && now > req.expiresAt) {
			requestsTable.delete({ id: req.id });
		}
	}
}
```

Run on a timer or piggyback on an existing periodic task.

## Scope: Per-Workspace, Opt-In

Not every workspace needs dispatch. A notes workspace has no runtime-specific actions. Adding a `requests` table is an explicit choice:

> Historical note: the example below uses an older workspace definition shape.
> Current apps put actions in the bundle returned by `create<App>()`
> and pass that registry to `openCollaboration()` or
> `attachProjectInfrastructure()`. Treat the request-table idea as architectural
> background, not current setup code.

```typescript
const tabManager = defineWorkspace({
	id: 'tab-manager',
	tables: {
		tabs,
		windows,
		devices,
		savedTabs,
		requests, // Opt-in to dispatch
	},
	kv: {},
});
```

The request schema is the same across workspaces. What varies is the `action` names and `input` shapes: those come from the workspace's action definitions.

## Integration with Existing Architecture

This pattern layers on top of the existing sync architecture:

```
┌─────────────────────────────────────────────────────────────┐
│ Transport: YJS WebSocket Sync (existing)                     │
│                                                              │
│   Y.Doc State:                                               │
│   - tables/     -> data                                      │
│   - requests/   -> action dispatch (opt-in)                  │
│                                                              │
│   Awareness:                                                 │
│   - deviceId    -> stable identity                           │
│   - type        -> browser/server/cli                        │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

No new connections needed. The same sync providers that replicate your data also handle dispatch.

## When to Use This vs HTTP

| Use HTTP                     | Use Requests Table               |
| ---------------------------- | -------------------------------- |
| Browser -> Server (standard) | Any runtime -> Browser extension |
| Public API endpoints         | Cross-runtime on same Y.Doc      |
| High-throughput operations   | Targeted device operations       |
| External clients             | Anything connected to workspace  |

For browser -> server, HTTP is simpler. Use the requests table when you need to reach a runtime that can't accept incoming connections.

## Related Documentation

- [Request Dispatch Spec](../../../../specs/20260213T103000-request-dispatch.md): Implementation spec with tab-manager examples
- [Device Identity](./device-identity.md): How devices identify themselves
- [Network Topology](./network-topology.md): Connection patterns
- [SYNC_ARCHITECTURE.md](../../SYNC_ARCHITECTURE.md): Multi-device sync details
