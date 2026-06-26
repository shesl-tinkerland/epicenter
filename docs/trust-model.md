# Trust model

Epicenter does not encrypt workspace data before syncing it. The relay runs Yjs and reads plaintext: document structure, entry keys, and values. That one decision is the trust model, and everything below is a consequence of it.

This page describes what the code does today. The files that carry it:

- `packages/server/src/room/core.ts`: the relay's `Room.sync()`
- `packages/server/src/room/backends/cloudflare/durable-object.ts`: the hosted backend
- `packages/workspace/src/document/workspace.ts` and `attach-local-storage.ts`: local persistence
- `packages/server/src/routes/session.ts`: `/api/session`

## We used to encrypt at rest. We stopped.

For a long time Epicenter encrypted every CRDT value before it entered the synced Yjs doc. The key came from a server-held root (`ENCRYPTION_SECRETS` to an owner key to a workspace key) and shipped to the client through `/api/session`. The philosophy was "if you want full encryption, become the server."

It worked, and the tell is that it still trusted the server. The root key lived on Epicenter's infrastructure, so server code could read your data, a bug could log it, an operator could inspect it. You were never server-blind; you were trusting the application. Once you grant that, the per-owner workspace key buys nothing but a key-recovery tax and a class of "unreadable cell" failures. So we deleted it: the `@epicenter/encryption` package, the keyring, the key derivation, and the `ENCRYPTION_SECRETS` root.

The full argument is in `docs/articles/20260615T140000-dont-encrypt-the-data-dont-hold-it.md`. The design that drove the removal is `specs/20260615T120000-trusted-relay-and-collaborative-fields.md`.

## What the relay sees

Everything. `Room.sync()` calls `Y.applyUpdateV2(doc, update, 'http')` and returns diffs with `Y.encodeStateAsUpdateV2`; the WebSocket path broadcasts raw Yjs protocol messages to peers. Because nothing is encrypted before it enters the doc, the synced values are plaintext application JSON. The relay reads structure, keys, and values alike.

This is deliberate. A trusted relay that can read the doc is what makes server-side search, AI as a Yjs peer, and offline garbage collection possible. A blind relay can do none of those, and the upcoming collaborative child-docs lean on it too: a blind relay cannot follow a stored child id, so a trusted one is what unlocks nested child documents and the offline mark-and-sweep that reclaims orphans.

Content is only half of what a relay learns. Sealed frames would still leave the routing in the clear, so the relay sees the metadata around the bytes: the authenticated user id, the connecting node id, which devices share a room (the presence frames), the names of dispatched actions, and the timing, size, and client IP of every message. That envelope outlives any future blind relay, which stops reading the values but still forwards them; sealing a frame hides what is inside it, not the fact that your phone and laptop touched this room at this minute. Run the relay yourself and the metadata is yours. Use Epicenter's and it is a who-talks-to-whom graph Epicenter can read.

## Big files (audio, images) follow the same rule

Workspace data rides the Yjs doc, but large binaries cannot (they would blow the CRDT's size caps), so audio and images go to a separate content-addressed blob store: an S3-compatible bucket reached through `packages/server/src/s3-blob-store.ts`. Those bytes are **not encrypted** either. The only cryptography on that path is plumbing, never secrecy: a SHA-256 that *names* each object by its content (addressing and dedup), the same digest reused as an integrity checksum the store verifies on upload, and SigV4 that signs the control-plane request. Reads are gated by auth plus a per-owner key prefix (`owners/<ownerId>/blobs/<sha256>`) behind short-lived presigned URLs, not by concealing the bytes. So a blob's confidentiality equals a document's: whoever operates the bucket can read it. Hosted, that operator is Epicenter (R2); self-hosted, it is your own bucket (Garage, S3). Same topology answer, different storage. (R2 and S3 encrypt at rest under their own keys, which the operator reads straight through, so that changes nothing about who can read your blob.)

One configuration is easy to get wrong here. The blob store is a service the star calls, not a part of the sync topology, so the bytes follow the store's endpoint, not the doc's home. A blob's upload URL is minted by whichever star is running, and the bytes land in that star's bucket. Self-host the docs but point blobs at Epicenter's blob service, and your media lands in Epicenter's R2, readable by Epicenter, the same trust as hosted docs, even though the doc itself never left your box. To keep media private on self-host, point the store at your own S3 (`BLOBS_S3_ENDPOINT`). A service only ever sees what you hand it; for the blob service, what you hand it is the bytes.

## Two deployments, decided by who holds the data

Epicenter Cloud, the default, is operated by Epicenter, so hosted data sits inside our trust boundary. It is the same promise as before, without the key-derivation machinery around it. `BETTER_AUTH_SECRET` still signs auth cookies, tokens, and OAuth state in `packages/server/src/auth/create-auth.ts`; it is not a workspace encryption root.

Self-hosting is functionally zero-knowledge against Epicenter, because Epicenter never holds or sees the data: you operate the deployment. The strength comes from topology, not from a held secret. So the marketing has to stay honest about which deployment it describes. "We cannot read your data" is true when you self-host, not on the default.

## Logging in still leans on Google

Self-host moves the data to your box, but the login does not move with it yet. The only wired sign-in is Google OAuth: `packages/server/src/auth/base-config.ts` disables email/password on purpose, because better-auth 1.5.6 has no local-email-verification gate and no mail sender is wired up, so a local account would open an account-takeover path. The cost was real: until now, a self-hoster registered a Google OAuth app to log into their own machine, a cloud dependency that cuts against the point of running your own box.

The fix is a local credential source, not a removed login gate. A solo self-host box now mints a single-user bearer token at first boot, persists it `0600`, and prints it once for the operator to paste into the client: a real authenticated user with no third-party issuer behind it, so a homelab needs no Google app to reach its own data (`docs/adr/0072-the-self-host-star-mints-and-persists-its-own-first-boot-bearer.md`). A box selects this whenever no OAuth provider is configured; configure one and it stays the shared-wiki Google path. Multi-user homelabs that want browser sign-in without a pasted token reach the same gate through a reverse-proxy header in front of their own identity provider, or through better-auth's API keys; those escape hatches are still ahead. The gate never goes away; only where the credential comes from changes (`docs/adr/0070-self-host-adds-no-new-ownership-or-auth-mode.md`).

## Where this is heading: the anchor

Privacy stops being an encryption layer and becomes a topology choice. The direction, validated in a throwaway local spike but not product code yet, is Iroh: every device gets a public-key identity and opens a direct, end-to-end-encrypted QUIC connection addressed by that key. When two devices cannot connect directly, a relay forwards the sealed frames it cannot decode.

The one place a server still has to be an endpoint is when your phone edits and your laptop is asleep: something always-on has to hold that update until the laptop wakes. That something is the anchor, and the anchor decrypts and stores. So "do we encrypt the data" becomes "who runs the anchor":

- Bring your own anchor, and nobody else ever holds your data. This is the privacy choice, stronger than the encrypted key-value ever was, with zero encryption code.
- Trust Epicenter's anchor, the default, and we hold your data, the same promise as today.

"Become the server" shrinks to "become the anchor": one always-on node instead of a whole auth-and-sync stack. The browser stays a relay-bound leaf (WASM, no UDP hole-punching), and the relay still cannot read the frames. Client-encrypted backup snapshots are the one place a sealed blob still earns its keep, and that primitive returns, minimal, when backup is built.

The local spike proved the shape worth keeping: a Mac Studio home anchor persisted a CRDT doc reached from a MacBook on phone hotspot; a JS/Yjs runtime then used a Rust/Iroh sidecar to stream live updates into that anchor and hydrate them back. That does not solve pairing, auth, packaging, browser access, or room multiplexing. It does prove the important boundary: TypeScript can keep owning Yjs/app semantics while Rust only owns native reachability.

## Migration

There is no deployed encrypted data to protect, so the migration is a one-off manual step: clear local devices and admin-wipe the Durable Object rooms once. No client IndexedDB name bump or in-script corruption guard is needed.
