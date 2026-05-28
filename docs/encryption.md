# Encryption architecture
Epicenter encrypts CRDT values before they enter the synced Yjs document.
That keeps the sync path moving ciphertext instead of application JSON.
This page only makes claims visible in the current code:
- `packages/encryption/src/index.ts`
- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts`
- `packages/workspace/src/document/workspace.ts`
- `packages/workspace/src/document/attach-local-storage.ts`
- `packages/workspace/src/document/wipe-local-storage.ts`
- `packages/workspace/src/document/attach-encrypted-indexed-db.ts`
- `apps/api/src/auth/encryption.ts`
- `apps/api/src/auth/create-auth.ts`
- `packages/svelte-utils/src/session.svelte.ts`
- `apps/api/src/room.ts`
If something is not visible there, it is not presented as fact here.

## What this system is
This is server-managed encryption at the workspace value layer.
It is not user-held end-to-end encryption.
The auth server derives per-owner keys from `ENCRYPTION_SECRETS` and returns them in the session response.
The client derives per-workspace keys locally and uses those keys to encrypt individual CRDT values.
That split is the trust boundary.
The sync path only relays encrypted values.
The auth path can derive owner keys because it has access to the deployment root keyring.

## Key hierarchy
The hierarchy is two-stage.
Server code derives a per-owner key.
Client code derives a per-workspace key from that owner key.
```text
ENCRYPTION_SECRETS entry        (root keyring)
        |
        | SHA-256(secret)
        v
root key material
        |
        | HKDF-SHA256 info = "owner:{ownerId}"
        v
owner key                       (per-owner keyring)
        |
        | HKDF-SHA256 info = "workspace:{workspaceId}"
        v
workspace key
        |
        | XChaCha20-Poly1305
        v
encrypted CRDT value
```
The HKDF info string at the owner derivation step is the literal `owner:{ownerId}`. The label fed into the HKDF call is the `ownerId` directly: the user's id in personal mode, the literal string `team` in team mode.

On the server, `apps/api/src/auth/encryption.ts` reads `ENCRYPTION_SECRETS` from the worker env and calls `@epicenter/encryption`'s `deriveKeyring` to parse the root keyring and derive a per-owner keyring.
It returns one `{ version, keyBytesBase64 }` entry per configured root keyring version.
On the client, `createWorkspace({ id, keyring, tables, kv })` reads `keyring()` once at construction, decodes each `keyBytesBase64`, runs `deriveWorkspaceKey(ownerKey, id)`, and gets a 32-byte workspace key with `info = workspace:{id}`. The derived keyring activates every encrypted store atomically before any handle is returned.
The highest version becomes the current key for new writes.

## How keys reach the client
Keys come through `/api/session`.
`apps/api/src/app.ts` mounts `GET /api/session` behind cookie-or-bearer authentication. A valid Better Auth cookie session or a valid API-audience bearer token for the user can fetch `{ user: { id, email }, ownerId, keyring, mode }`, where `ownerId` is a branded id (the user's id in personal mode, the literal `team` in team mode) and `mode` is the orthogonal `OwnershipMode` flag.
`@epicenter/auth` calls `/api/session` at sign-in and at cold-boot when online, persists `{ ownerId, keyring, mode }` alongside the OAuth grant in the persisted auth cell, and exposes them through `auth.state.ownerId` / `auth.state.keyring` / `auth.state.mode` whenever the auth state is not `signed-out`.
Cold-boot offline keeps the cached `{ ownerId, keyring, mode }` so the workspace can decrypt local Yjs data without a network roundtrip; the bearer is not attached to outbound requests until `/api/session` re-confirms the cell in this runtime.
The workspace does not hold an independently mutable copy of the keys. `createWorkspace` takes a `keyring` callback and calls it once at construction; `attachLocalStorage` takes the same callback and calls it on every persisted update. Each encrypted store keeps the keyring derived at its `createWorkspace` boundary. Browser app session modules receive a flat `SignedIn` payload from `createSession`; that payload carries the lazy keyring reader and the stable owner:
```ts
import { createSession, type SignedIn } from '@epicenter/svelte';
import { createDeviceId } from '@epicenter/workspace';

export const session = createSession({
	auth,
	build: (signedIn: SignedIn) =>
		openMyApp({
			signedIn,
			deviceId: createDeviceId({ storage: localStorage }),
		}),
});
```
`SignedIn` is `{ server, baseURL, ownerId, keyring, openWebSocket, onReconnectSignal }`. `ownerId` is derived from the auth signed-in state and stays stable for the lifetime of a single `SignedIn` payload. `keyring` is a callback that reads the current keyring from `auth.state`, so same-owner rotations are picked up on the next call without rebuilding the payload. `openCollaboration({ openWebSocket, onReconnectSignal })` uses the auth-owned WebSocket opener and reconnect signal, so per-app openers do not write reconnect glue. A different-owner sign-in publishes a `signed-out` gap first, which disposes the payload and rebuilds with the new owner.

Same-owner identity updates do not remount the workspace. Auth callbacks read `auth.state` at the boundary that asks for them: sync can see refreshed bearer tokens on connection attempts, and `attachLocalStorage`'s IDB writes pick up rotated keys on the next persisted update. Already-attached encrypted tables and KVs keep the keyring they derived when `createWorkspace` was called; a fresh `createWorkspace` call (and therefore a fresh Y.Doc) is required for them to pick up rotated keys.

Daemon-side project mounts receive the same auth-derived capabilities through `MountContext`: `{ projectDir, mount, yDocClientId, deviceId, ownerId, keyring: () => Keyring, openWebSocket, onReconnectSignal }`. The host's `keyring` closure throws when auth is signed-out, so a late sign-out becomes a thrown error at the next encrypted write or registration site rather than silent ciphertext loss. The `openWebSocket` and `onReconnectSignal` refs flow through to `attachProjectInfrastructure({ openWebSocket, onReconnectSignal })` for cloud sync.

## Browser local persistence
Authenticated browser workspaces open local IndexedDB only after auth has settled into an identity-bearing state. The session module guarantees that boundary: it builds the workspace lazily once auth produces a `SignedIn` payload and disposes it on sign-out.

The workspace bundle and the local-storage attachment cover the local-data surface and they read directly off the same `SignedIn` payload:
- `createWorkspace({ id, keyring, tables, kv })` allocates the `Y.Doc`, derives the per-workspace HKDF keyring, and constructs every encrypted table and KV store in one atomic call. The factory does not own local storage: it only allocates the doc, derives keys, and activates the encrypted CRDT wrappers.
- `attachLocalStorage(ydoc, { server, ownerId, keyring })` opens `(server, ownerId)`-scoped encrypted IndexedDB persistence and pairs it with a matching `BroadcastChannel` under the same name. The `server` and `ownerId` are snapshotted at attach time (stable for the attachment lifetime), and `keyring` is a callback so the IDB layer picks up rotated keys on the next persisted update.

The browser factory shape is (from `apps/fuji/src/lib/browser.ts`):
```ts
export function openFujiBrowser({
	signedIn,
	deviceId,
}: {
	signedIn: SignedIn;
	deviceId: DeviceId;
}) {
	const workspace = createFujiWorkspace({ keyring: signedIn.keyring });

	const idb = attachLocalStorage(workspace.ydoc, {
		server: signedIn.server,
		ownerId: signedIn.ownerId,
		keyring: signedIn.keyring,
	});
	const collaboration = openCollaboration(workspace.ydoc, {
		url: roomWsUrl({
			baseURL: signedIn.baseURL,
			ownerId: signedIn.ownerId,
			guid: workspace.ydoc.guid,
			deviceId,
		}),
		openWebSocket: signedIn.openWebSocket,
		onReconnectSignal: signedIn.onReconnectSignal,
		waitFor: idb.whenLoaded,
		actions: workspace.actions,
	});
	// ...
}
```

`createFujiWorkspace({ keyring })` is the per-app helper that wraps `createWorkspace` with Fuji's typed `tables` and `kv` schemas, adds Fuji actions and shared child-doc models, and returns the same `{ ydoc, tables, kv, actions, [Symbol.dispose] }` bundle shape through `defineWorkspace`.

`attachLocalStorage` reads exactly `{ server, ownerId, keyring }` from the explicit options object. The call site destructures `signedIn` so the dependency is visible in the code, not implied by structural typing.

The storage name is derived inside `@epicenter/workspace` as:
```text
epicenter/{server}/owners/{ownerId}/{ydocGuid}
```

The same prefix is used in both modes; in personal mode `ownerId === user.id`, and in team mode `ownerId === 'team'`.

App code does not build that string. Device cleanup uses the free function `wipeLocalStorage({ server, ownerId })`, which enumerates `indexedDB.databases()` and deletes every entry whose name starts with the durable `(server, ownerId)` prefix `epicenter/<server>/owners/<ownerId>/`. It no-ops gracefully when `indexedDB.databases()` is unavailable. A typical sign-out or "delete my local data" path looks like:
```ts
await wipeLocalStorage({ server: signedIn.server, ownerId: signedIn.ownerId });
```

## Key lifecycle in the current code
Keys are definitely loaded on login.
That part is explicit.
Sign-out disposes the live workspace after the auth session changes.
It does not wipe local IndexedDB data.
The reviewed code still does not show an explicit in-memory key wipe inside `createEncryptedYkvLww`; workspace disposal is the current key-drop boundary for `createSession` apps.
The closest Bitwarden analogy is lock, not logout: Bitwarden documents unlock as using encrypted data already stored on disk and lock as deleting decrypted vault data and the account encryption key from memory. Bitwarden separately documents that logout wipes PIN settings. See [Understand Log In vs. Unlock](https://bitwarden.com/help/understand-log-in-vs-unlock/) and [Unlock With PIN](https://bitwarden.com/help/unlock-with-pin/).
The logout path is owned by the per-app session module. `createSession` reconciles `auth.state` against the live workspace: sign-out disposes the workspace, and same-owner updates are a no-op at the session boundary. A different owner publishes a `signed-out` gap first, which disposes the current payload before the new owner mounts:
```ts
import { createSession, type SignedIn } from '@epicenter/svelte';
import { createDeviceId } from '@epicenter/workspace';

export const session = createSession({
	auth,
	build: (signedIn: SignedIn) =>
		openFujiBrowser({
			signedIn,
			deviceId: createDeviceId({ storage: localStorage }),
		}),
});
```
The returned workspace bundle's `Symbol.dispose` tears down the root and any cached child Y.Docs. Local IDB data is not wiped on sign-out by default; an app that wants "delete my local data on logout" calls `wipeLocalStorage({ server: signedIn.server, ownerId: signedIn.ownerId })` explicitly (Fuji exposes this through `bundle.wipe()`).

So these points are implemented and verifiable:
- keys are loaded on login
- sign-out disposes the live workspace
- a different `/api/session` owner wipes the persisted auth cell and publishes `signed-out`
- owner-scoped IndexedDB data remains available for the same authenticated user after reload
This point is not visible as an explicit step in the reviewed code:
- clearing the in-memory encryption state after logout
That gap matters because the encrypted wrapper exposes `activateEncryption()` but no `deactivateEncryption()`.
If you are reviewing the threat model, treat that as a real property of the current implementation.

## Binary envelope format
Encrypted values are stored as a bare `Uint8Array`.
There is no JSON ciphertext wrapper.
The v1 layout is exactly:
```text
formatVersion(1) || keyVersion(1) || nonce(24) || ciphertext || tag(16)
```
The byte layout looks like this:
```text
Byte:  0              1              2                           26
       +--------------+--------------+---------------------------+----------------------+
       | formatVersion| keyVersion   | nonce                     | ciphertext || tag    |
       | 1 byte       | 1 byte       | 24 bytes                  | variable + 16 bytes  |
       +--------------+--------------+---------------------------+----------------------+
```
The minimum blob size is 42 bytes.
That is `2 + 24 + 16`, which is the empty-plaintext case.
`encryptValue()` writes the header like this:
- byte 0: format version, currently `1`
- byte 1: key version
- bytes 2..25: random 24-byte nonce
- bytes 26..end: ciphertext plus the 16-byte Poly1305 tag
`decryptValue()` validates the format version first.
If it is not `1`, decryption throws.
The key version is metadata, not decryption logic by itself.
The wrapper reads `blob[1]` with `getKeyVersion(blob)` and chooses the matching key before calling `decryptValue()`.

## Why XChaCha20-Poly1305
The code uses XChaCha20-Poly1305 from `@noble/ciphers`.
The reason is simple: workspace writes are synchronous, so the encryption path must also stay synchronous.
The implementation uses a 32-byte key, a 24-byte nonce, and optional AAD.

## Encrypted CRDTs without forking the CRDT
Epicenter does not fork the LWW CRDT.
It wraps it.
The core store is `YKeyValueLww`.
The encryption layer is `createEncryptedYkvLww()`.
That wrapper keeps timestamps, conflict resolution, pending state, and observer mechanics in the original CRDT and only transforms values at the boundary.
The write path is:
```text
set(key, value)
  -> JSON.stringify(value)
  -> encryptValue(json, workspaceKey, aad = keyBytes, keyVersion)
  -> inner.set(key, encryptedBlob)
```
The read path is:
```text
get(key)
  -> inner.get(key)
  -> decryptValue(blob, selectedKey, aad = keyBytes)
  -> JSON.parse(json)
```
Observers follow the same pattern.
The inner CRDT emits changes, the wrapper decrypts changed entries, and callers see plaintext change events.
The reason for composition is concrete.
The file comment explains that Yjs `ContentAny` stores entry objects by reference, and `YKeyValueLww` relies on `indexOf()` with strict reference equality.
If the CRDT were forked to replace entries with freshly decrypted objects, that reference equality would break.
So the design is not “encryption-aware CRDT logic.”
It is “existing CRDT logic plus an encryption wrapper at the edges.”

## What is and is not encrypted
The value payload is encrypted.
The surrounding CRDT structure is not.
That means a synced entry still has a key and timestamp in the Yjs data model.
What changes is the `val` field.
When encryption is active, `val` becomes an opaque `Uint8Array` blob.
The code also binds the entry key as AAD by passing `textEncoder.encode(key)` to both encrypt and decrypt.
That prevents a simple ciphertext transplant from one entry key to another.

## No plaintext cache
Reads decrypt on the fly.
The wrapper does not maintain a separate plaintext cache.
That trade is explicit in the implementation comments: decrypting a small XChaCha20-Poly1305 blob is cheap, while a dual cache would add complexity around observers, resync, and missed transactions.
`entries()` decrypts values as it iterates.
Undecryptable entries are skipped.

## One-way activation
Encryption activation is one-way by API surface.
The wrapper has `activateEncryption(keyring)`.
It does not have `deactivateEncryption()`.
Before activation, the wrapper is a passthrough store and `set()` writes plaintext values into the inner CRDT.
After activation, `set()` always encrypts.
The active state holds the full keyring, the current key, and the current key version.
Calling `activateEncryption()` again updates that state to a new keyring, but it does not switch the store back to plaintext mode.
The workspace factory reinforces that shape: `createWorkspace({ id, keyring, tables, kv })` takes the full table and KV definition record up front and returns the constructed encrypted handles atomically. It reads `keyring()` once, derives the per-workspace keyring with `deriveWorkspaceKeyring(ownerKeyring, id)`, and activates every store before any handle is returned. There is no separate `applyKeys` mutation step and no temporal registration window: Y.Doc allocation, key read, registration, and activation all happen in one call.

## What activation re-encrypts
Activation rewrites every decryptable entry that is not already stored under the current key version.
The current key is the highest version in the supplied keyring.
The code in `activateEncryption()` walks the inner map and handles four cases:
- plaintext entries are encrypted with the current key version
- encrypted blobs at a non-current version are decrypted through the keyring and re-encrypted with the current key version
- encrypted blobs already at the current version are skipped
- encrypted blobs whose key version is missing from the keyring are left unreadable and unchanged
If a new keyring makes old blobs readable, activation also emits synthetic add events so observers can see them.

## Key rotation
Key rotation is versioned and activation-driven.
The blob carries the key version that encrypted it.
New writes always use the highest key version in the active keyring.
Decryption follows this order:
1. try the current key first
2. if that fails, read `blob[1]`
3. look up that version in the keyring
4. try that specific key
That avoids brute-forcing every key.
The blob tells the client which version it needs.
When `activateEncryption()` receives a newer highest-version key, decryptable old-version blobs are re-encrypted under that current version during the activation pass.
Blobs for versions absent from the keyring stay unreadable and unchanged until a future activation includes the needed key.

## What the sync server sees
The sync server sees Yjs updates and relays them.
In the reviewed server code, `Room.sync()` calls `Y.applyUpdateV2(this.doc, update, 'http')` and returns diffs with `Y.encodeStateAsUpdateV2(this.doc, clientSV)`.
The WebSocket path broadcasts raw protocol messages to peers.
There is no decryption step in that sync room code.
Because encryption happens before values are written into the Yjs document, the synced value payloads are ciphertext blobs.
Be precise here.
The relay does not see only random bytes.
It still sees the CRDT skeleton: document structure, entry keys, and timestamps.
What it does not get is plaintext application values.

## Error handling and unreadable data
Decryption failures do not take down the whole observer stream.
The wrapper catches failures, logs a warning, skips the unreadable entry, and keeps going.
It also exposes `unreadableEntryCount` alongside `size` (the count of decryptable entries).
That makes corruption or missing key versions visible without forcing a hard crash on every read.

## What this means for a security review
The useful parts are clear.
Values are encrypted before sync, the blob format is self-describing, key rotation is versioned, and the CRDT logic is reused instead of forked.
The trust model is also clear.
This is not a zero-knowledge design.
The auth server can derive per-user transport keys from `ENCRYPTION_SECRETS`, while the sync relay forwards ciphertext values rather than plaintext values.
The sharp edge is logout behavior.
App auth-transition hooks reload the browser client on logout or user switch, but an explicit in-memory key deactivation path is not present in the reviewed code.
If you are deciding whether this architecture fits your threat model, focus on that line: the sync relay handles ciphertext values, but the deployment that owns `ENCRYPTION_SECRETS` remains inside the trust boundary.
