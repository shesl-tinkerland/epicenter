# 0010. Settings project into native runtime state and are never mirrored

- **Status:** Accepted
- **Date:** 2026-06-16

## Context

Whispering's desktop backends each held an authoritative copy of a frontend
setting (the active transcription model in Rust's model manager; the
global-shortcut bindings plus the rdev listener thread), reconciled only when
the setting *value* changed. The failures were never value changes but world
changes: a model file reappearing on disk after a failed load, a permission
regranted, or the rdev listener thread dying. The stale copy then persisted
until an app restart re-read the world, which is why "restart fixes it" was the
universal workaround (#2034, with the stale-binding lifecycle in #2033). A
latent third instance rode along: `unloadPolicy` was bundled into the
transcription config, so it could not be delivered while no model was selected.

## Decision

The frontend owns every setting value; native owns mechanism only (the loaded
model, the listener thread, the idle clock), never authority. Delivery takes one
of two forms, chosen by *when the value is consumed*:

- **Consumed at use → read-at-use.** The value travels with the operation.
  Transcription takes a per-call `TranscriptionSpec`; Rust keeps only a
  `ModelCache` (resident model, disk identity, unload clock, status, lifecycle
  events) and resolves the model path at load time. There is no ambient config
  to go stale.
- **Consumed between uses → reconcile the value into the resource.** A
  backgrounded passive listener or idle timer cannot be read at use, so the
  frontend reconciles its value into the native resource on every relevant input
  change, where "input" includes world-signals (thread liveness, permission),
  not only the setting value, and native supervises the resource so its death is
  a non-event. Unload policy reconciles onto its own `set_unload_policy` channel;
  global shortcuts reconcile the binding set and restart the rdev listener after
  a `ListenerStoppedEvent`, gated on standing `accessibilityGranted` /
  `listenerAlive` signals.

`set` and `sync` are the smell verbs: both shove a copy across a boundary and
hope it stays put.

## Consequences

- "Restart fixes it" becomes structurally impossible for transcription: every
  transcribe is its own little restart. The eager model-path latch,
  `set_transcription_config`, and the mount-only config effect are deleted, not
  fixed.
- A dead rdev listener self-heals without a restart, and the
  first-shortcut-edit-not-taking-effect asymmetry disappears.
- `unloadPolicy` reaches Rust whether or not a model is selected, fixing the
  latent third bug.
- Rust keeps the idle clock, not the frontend: a backgrounded webview timer
  throttles exactly when idle-eviction must fire to reclaim RAM. This is earned
  native state, not mirrored authority.
- The convention is `install*Runtime()` disposers plus pure `desired*` /
  projection functions, deliberately not a generic reconciler framework: there
  are about four cross-boundary concerns, and subtraction beats abstraction here.

## Considered alternatives

- **Frontend owns the eviction clock (zero native settings).** Rejected:
  backgrounded webview timers throttle exactly when idle-eviction must fire.
- **One shared config substrate both sides read (SQLite/Turso).** Rejected:
  large migration, fights the Yjs substrate, cross-language reactivity is its own
  project; read-at-use already makes the transcription copy vanish.
- **A generic reconciler framework.** Rejected: about four concerns; a
  convention beats a framework.

Relates to
[ADR-0007](0007-local-shortcuts-sync-global-shortcuts-stay-per-device.md)
(global shortcuts stay per-device) and
[ADR-0008](0008-rdev-backs-the-desktop-global-trigger.md) (rdev backs the
desktop global trigger).
