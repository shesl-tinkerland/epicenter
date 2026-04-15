# Write Workspace Sync Testing Guide

## Task

Write a practical testing guide for workspace sync at `docs/testing-workspace-sync.md` in the Epicenter monorepo. Target audience: a contributor (like John) who wants to verify sync works locally.

## Context

### Architecture

Workspace sync uses Yjs CRDTs over WebSocket:

- **Client:** `createSyncExtension({ url, getToken })` in `packages/workspace/src/extensions/sync/websocket.ts`
- **Server:** Cloudflare Durable Objects in `apps/api/src/`
  - `base-sync-room.ts`—WebSocket upgrade, handshake, message dispatch, persistence
  - `workspace-room.ts`—workspace DO (`gc: true`)
  - `document-room.ts`—document DO (`gc: false`) + snapshot auto-save
- **Protocol:** `packages/sync/src/protocol.ts`—wire format encoding/decoding
- **Routes:** `apps/api/src/app.ts`—`/workspaces/:workspace` and `/documents/:document` endpoints

### Client wiring example (from `apps/tab-manager/src/lib/client.ts`):

```typescript
.withExtension('sync', createSyncExtension({ url, getToken }))
// then workspace.extensions.sync.reconnect() on login/logout
```

### Existing test files

- `packages/sync/src/protocol.test.ts`—wire format unit tests
- `packages/workspace/src/extensions/sync/websocket.test.ts`—extension lifecycle
- `apps/api/src/sync-handlers.test.ts`—server handler integration tests

### Existing spec

- `specs/20260310T202500-sync-integration-tests.md`—explains the mock WebSocket testing approach for server handlers

### CORS config

`trustedOrigins` in `apps/api/src/auth/create-auth.ts` dynamically builds from APPS ports in `packages/constants/src/apps.ts`. Localhost ports covered: 5173, 1420, 5174, 5175, 5176, 8888, 5178.

### Apps with sync enabled

- tab-manager, opensidian, honeycrisp, fuji (check their `src/lib/client.ts`)

## Guide Structure

1. **Running existing tests**—exact commands for each test suite
2. **Local manual testing**—step by step:
   - Start the API locally (wrangler dev or equivalent)
   - Start an app (e.g., tab-manager or opensidian)
   - Open two browser tabs/windows
   - Make a change in one, verify it appears in the other
   - Check sync status indicator
3. **Common issues**—CORS errors (trustedOrigins), auth token setup, WebSocket connection failures
4. **Environment setup**—required env vars, auth configuration

## Writing Voice

Use the Epicenter writing-voice: direct, no AI filler, em dashes closed (no spaces). Use code blocks liberally. Keep prose short—this is a reference doc, not a tutorial.

## MUST DO

- Include exact `bun test` commands with package paths
- Include the actual localhost ports from APPS config
- Mention BroadcastChannel cross-tab sync (included automatically)
- Reference the existing spec for deeper server-side testing context
- Keep it under 200 lines—concise reference, not a book

## MUST NOT DO

- Do not modify any source code files
- Do not create test files
- Do not include deployment/production testing instructions
- Do not duplicate content from the existing spec
