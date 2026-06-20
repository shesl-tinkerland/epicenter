# 0041. The secret vault has one storage home at a time, never an override resolver

- **Status:** Accepted
- **Date:** 2026-06-20

## Context

Whispering provider keys live in plaintext device config. The secret vault adds a
second home for them: an end-to-end-encrypted, synced store. Two homes invite a
precedence model, read the vault, fall back to the device, the way VS Code layers
settings. That resolver is a trap for credentials: a single secret can then exist
in two places with a silent winner, and every write has to choose a layer. A
provider key is a single-valued credential, not layered configuration.

## Decision

A secret has exactly one home at any moment: the device (plaintext `localStorage`
via `deviceConfig`, the default, never synced) or the vault (encrypted, synced).
There is no precedence stack and no resolver. Turning sync on migrates every secret
off the device into the vault and clears the device copy; turning it off migrates
back. The home is the one place destination is a user choice. The set of routed
keys is owned directly by the device handle (its `SECRET_KEYS`), not a separate
registry, and a guard test keeps account-synced KV names from ever colliding with
them. One credential facade is the only place the app reads or writes a secret, and
a read returns an explicit `available | locked | missing` so a locked vault is never
mistaken for an unset key or papered over as a blank string.

## Consequences

- One home means no ambiguity about which value wins or where a write lands.
- Migration is an explicit, destructive move, the old copy is cleared, so a
  half-migrated secret cannot linger in two homes.
- The facade exposes the lock state honestly instead of handing a caller a blank
  key, so a locked vault prompts to unlock rather than calling a provider SDK with
  an empty credential.
- Cost: there is no graceful "read from either home" fallback. A secret in the
  wrong home reads as `missing` until migrated, and migrating out of the vault
  requires it unlocked.

## Considered alternatives

- **VS Code-style layered override resolution.** Rejected: precedence hides which
  store answered and forces every write to pick a layer; single-valued credentials
  gain nothing from layering and lose the ability to clear a value cleanly.
- **A registry of secret keys separate from the device handle.** Rejected: the
  device handle already owns the keys; a second list is one more thing to keep in
  sync and a place for the guard invariant to drift.
