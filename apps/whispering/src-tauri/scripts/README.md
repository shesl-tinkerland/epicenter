# Dev macOS Accessibility identity

`bun run dev` launches Whispering under its own macOS identity,
`so.epicenter.whispering.dev`, separate from the released **Whispering**
(`so.epicenter.whispering`). Grant Accessibility once and global shortcuts keep
working across rebuilds.

Because dev runs a bare binary rather than a `.app`, its System Settings entry
may be labelled `whispering` rather than `Whispering Dev`; what is guaranteed is
that it is a *distinct* entry from production, so granting one never touches the
other.

## Why this is not just a flag

`tauri dev` runs the bare `target/debug/whispering` binary, not a `.app` bundle,
and it ignores `bundle.macOS.signingIdentity`. Cargo's linker leaves that binary
ad-hoc signed, so its code-signing identity is its cdhash, which changes on every
relink. macOS Accessibility (TCC) keys the grant on that identity, so each Rust
rebuild looked like a brand-new app and the grant went stale. The Rust
supervisor then reported `DictationCapability::Broken`.

The fix is a stable signature, not a bundle id. Tauri's `build.runner` hook
(`tauri.dev.macos.conf.json`) points `tauri dev` at
[`dev-codesign-runner.sh`](./dev-codesign-runner.sh), which builds, re-signs the
binary with a stable cert and the fixed identifier `so.epicenter.whispering.dev`,
then `exec`s it. The resulting designated requirement depends only on the
identifier and the certificate, never the cdhash, so the grant survives rebuilds.

The signing cert defaults to the first Developer ID or Apple Development identity
on the machine. Override it with `WHISPERING_DEV_SIGNING_IDENTITY`. With no cert
the runner falls back to ad-hoc and warns that the grant will not persist.

## Granting and resetting

First `bun run dev` after this change re-prompts for Accessibility (the identity
changed). Grant the new entry in System Settings > Accessibility, once.

To start clean (the binary must have launched at least once so the entry exists):

```sh
tccutil reset Accessibility so.epicenter.whispering.dev
```

Then relaunch dev and grant Accessibility again.

## Diagnosing

```sh
bun run dev:doctor
```

prints the dev binary path, its signed identifier and authority, whether the
signature is stable, and the reset command. Live trust, the current
`DictationCapability`, and the rdev listener's health are owned by the running
app's supervisor (`src/keyboard/mod.rs`) and show up in the app and the Tauri
log.
