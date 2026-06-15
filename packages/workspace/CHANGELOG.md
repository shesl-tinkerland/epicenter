# @epicenter/workspace

## 0.3.0

### Minor Changes

- f8f6c4e: Rename `toWsUrl` to `websocketUrl` to make sync URL construction explicit while still deriving WebSocket URLs from the configured HTTP API origin.
- e0b5ac0: Trim three zero-consumer exports off the public surface: `readMetadataFromPath` and `buildDaemonActions` leave the `./node` barrel (both stay as internal helpers), and `typedDispatch` / `TypedDispatch` leave the root barrel (the named `as` cast had no shipped consumer).

### Patch Changes

- @epicenter/sync@0.3.0
- @epicenter/encryption@0.3.0
- @epicenter/field@0.3.0
- @epicenter/identity@0.3.0
