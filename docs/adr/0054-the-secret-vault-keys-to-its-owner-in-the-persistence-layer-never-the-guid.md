# 0054. The secret vault keys to its owner in the persistence layer, never the guid; forgetting is a local detach

- **Status:** Accepted
- **Date:** 2026-06-20

## Context

The vault is a passphrase-locked, end-to-end-encrypted Y.Doc that syncs through the
relay. The relay partitions every owner's rooms under `owners/<ownerId>/rooms/<roomId>`,
so a synced vault must scope to an owner. But Whispering has no auth yet, and adding
a vault must not force an identity model onto an app that lacks one: the vault must
not lead its host's identity. So the open question is what a vault keys to in an app
with no signed-in account, and how that path grows into an account-aware one without
the vault ever inventing an account.

## Decision

The vault's guid is a stable per-app constant. The owner is never concatenated into
the guid; it lives in the persistence layer.

- **When an account is available**, the vault attaches via
  `attachLocalStorage(ydoc, { server, ownerId })`, which derives the IndexedDB
  database name and BroadcastChannel key from `(server, ownerId, guid)`, mirroring
  the relay's `owners/<ownerId>/rooms/<guid>` partition. The framework disposes the
  vault on sign-out and remounts it on sign-in.
- **When no account is available** (Whispering today), the vault attaches via raw
  `attachIndexedDb` under one implicit, local, per-device owner, exactly the
  persistence the host app's own workspace already uses. The vault matches its host
  rather than leading it, so it assumes no identity the host does not have.

Forgetting a vault, the lost-passphrase recovery path, is a **local detach**: it
wipes this device's replica only and must never propagate CRDT deletes, so forgetting
on one device never destroys a sibling's still-unlockable vault. Losing the
passphrase loses the synced values, and that is the accepted cost.

## Consequences

- The same vault code runs unchanged from no-auth Whispering to a future
  account-aware app; only the persistence attachment swaps, and the guid never moves.
- Two accounts on one browser profile, or one account on two shared-wiki servers,
  never collide on local storage or cross-tab updates.
- Because the no-account path is just the host's own local persistence, shipping the
  vault foundation forces no auth model and no behavior change: with no provisioning
  UI the vault stays `absent` and every key stays in plaintext device config, exactly
  as before. Encryption-and-sync is earned only once auth lands.
- Cost: the no-account vault is per-device and unsynced. And `forget` accepts data
  loss by design, distinct from `disableSync`, which migrates the values back before
  tearing the vault down.

## Considered alternatives

- **Concatenate the owner into the guid (`<guid>:<ownerId>`).** Rejected: it changes
  the doc's identity per owner and scatters the scoping into every guid string; the
  persistence layer already keys by owner and is where the relay scopes too.
- **Make the vault account-aware now, behind a stub identity.** Rejected: it forces
  an auth model onto an app that has none, the exact "vault leads its host" failure.
- **Use `disableSync`/`destroy` semantics for `forget`.** Rejected: destroy
  propagates deletes and would, under relay sync, wipe a sibling device's still
  recoverable vault. `forget` must be a local-only teardown.
