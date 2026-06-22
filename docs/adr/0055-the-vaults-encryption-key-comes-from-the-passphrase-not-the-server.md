# 0055. The vault's encryption key comes from the passphrase, not the server; that key source is the only zero-knowledge lever

- **Status:** Accepted
- **Date:** 2026-06-20

## Context

The encrypted-KV primitive (`createEncryptedYkvLww`) encrypts values at the
key-value layer and is agnostic about where its keyring comes from. The workspace
path derives a keyring from a server-issued root key (`deriveWorkspaceKey`, via
HKDF): that is encrypted-at-rest but not zero-knowledge, because the server can
reconstruct the key. The vault needs end-to-end secrecy: the relay must sync
ciphertext it can never read. Since the primitive is key-source agnostic, the key
source is the entire lever that turns encrypted-at-rest into end-to-end.

## Decision

The vault's keyring is derived from a user passphrase the server never sees:

```txt
passphrase + salt ─Argon2id─► KEK ─unwraps─► master key ─► keyring (v1)
```

The salt and Argon2id parameters are stored as plaintext vault metadata so any
device with the passphrase re-derives. The KEK (key-encryption key) only wraps and
unwraps the master key and is never persisted. The master key is a stable random 32
bytes, generated once and stored only in wrapped form, and it feeds the encrypted KV
directly. There is deliberately no HKDF step between the master key and the keyring:
HKDF scoping isolates many workspaces sharing one root key, but a vault has its own
random master key and a single namespace, so there is no sibling to isolate from.

## Consequences

- The relay stores and syncs only ciphertext plus unlock metadata it cannot use.
- A passphrase change rewraps the master key without re-encrypting a single value
  and without forcing re-entry on other devices: only the wrapping metadata changes,
  never the encryption key.
- Cost, stated honestly: the salt, parameters, and wrapped master key all ride the
  relay so a second device can unlock, so anyone holding that metadata can mount an
  offline brute force. Argon2id raises the per-guess cost but cannot save a guessable
  passphrase, so passphrase entropy does nearly all the security work (hence the
  strength assessor and generator live next to the crypto).
- Losing the passphrase loses the values: there is no server-side recovery, by
  design. See ADR 0054 for the local `forget` path that makes that reachable.

## Considered alternatives

- **Derive the keyring from a server-issued root key via HKDF** (the workspace
  path). Rejected for the vault: the server could reconstruct the key, so it is
  encrypted-at-rest, not zero-knowledge.
- **Derive the cipher key straight from the passphrase, no master-key indirection.**
  Rejected: every passphrase change becomes a full re-encryption and a forced
  re-entry on every other device.
- **Add an HKDF step after the master key.** Rejected: nothing to isolate, one
  vault is one namespace with one random master key.
