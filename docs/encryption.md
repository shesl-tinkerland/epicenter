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

## Two tiers, decided by who holds the data

Epicenter Cloud, the default, is operated by Epicenter, so hosted data sits inside our trust boundary. It is the same promise as before, without the key-derivation machinery around it. `BETTER_AUTH_SECRET` still signs auth cookies, tokens, and OAuth state in `packages/server/src/auth/create-auth.ts`; it is not a workspace encryption root.

Self-hosting is functionally zero-knowledge against Epicenter, because Epicenter never holds or sees the data: you operate the deployment. The strength comes from topology, not from a held secret. So the marketing has to stay honest about which tier it describes. "We cannot read your data" is true when you self-host, not on the default.

## Where this is heading: the anchor

Privacy stops being an encryption layer and becomes a topology choice. The direction, validated in a throwaway local spike but not product code yet, is Iroh: every device gets a public-key identity and opens a direct, end-to-end-encrypted QUIC connection addressed by that key. When two devices cannot connect directly, a relay forwards the sealed frames it cannot decode.

The one place a server still has to be an endpoint is when your phone edits and your laptop is asleep: something always-on has to hold that update until the laptop wakes. That something is the anchor, and the anchor decrypts and stores. So "do we encrypt the data" becomes "who runs the anchor":

- Bring your own anchor, and nobody else ever holds your data. This is the privacy tier, stronger than the encrypted key-value ever was, with zero encryption code.
- Trust Epicenter's anchor, the default, and we hold your data, the same promise as today.

"Become the server" shrinks to "become the anchor": one always-on node instead of a whole auth-and-sync stack. The browser stays a relay-bound leaf (WASM, no UDP hole-punching), and the relay still cannot read the frames. Client-encrypted backup snapshots are the one place a sealed blob still earns its keep, and that primitive returns, minimal, when backup is built.

The local spike proved the shape worth keeping: a Mac Studio home anchor persisted a CRDT doc reached from a MacBook on phone hotspot; a JS/Yjs runtime then used a Rust/Iroh sidecar to stream live updates into that anchor and hydrate them back. That does not solve pairing, auth, packaging, browser access, or room multiplexing. It does prove the important boundary: TypeScript can keep owning Yjs/app semantics while Rust only owns native reachability.

## Migration

There is no deployed encrypted data to protect, so the migration is a one-off manual step: clear local devices and admin-wipe the Durable Object rooms once. No client IndexedDB name bump or in-script corruption guard is needed.
