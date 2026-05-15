# Single Daemon, Many Workspaces

**Date**: 2026-05-14
**Status**: Phase 1 in progress
**Author**: Braden + Claude
**Related**: `20260514T160000-script-surfaces-resolution.md` (scripts call into this daemon over unix socket).

## One sentence

One Bun process named `epicenterd` hosts every workspace the user has open, sharing auth, lifecycle, and a unix socket; each app contributes a workspace route, not a daemon.

## Why this matters

Today, every Epicenter app starts its own daemon process. A user running Fuji plus Honeycrisp plus Opensidian plus Zhongwen has four Bun processes, four `createMachineAuthClient()` instances racing on the same keychain slot, four WebSockets to the relay, four foregrounded `epicenter daemon up` invocations to babysit, and four resident Y.Docs eating memory. Per app, that's not bad. At ten workspaces it stops being free.

The architecture **already supports** one process hosting N workspaces. The daemon's Hono app is built from `DaemonRouteDefinition[]` (`packages/workspace/src/daemon/types.ts`), routes are prefixed in the `/run` dispatcher (`packages/workspace/src/daemon/app.ts:97`), and materializer paths are keyed by `(projectDir, workspaceId)` so they don't collide (`packages/workspace/src/document/workspace-paths.ts:45-86`). The blocker is configuration shape and a small number of bugs the multi-instance shape hides.

## Today's state

```
$ ps aux | grep bun
braden  ...  bun run apps/fuji/daemon.ts
braden  ...  bun run apps/honeycrisp/daemon.ts
braden  ...  bun run apps/opensidian/daemon.ts
braden  ...  bun run apps/zhongwen/daemon.ts
```

```
~/Project/.epicenter/
├── daemon.sock        ← one per projectDir, but each app uses its own projectDir
├── yjs/
│   ├── epicenter.fuji.db
│   ├── epicenter.honeycrisp.db
│   ├── ...
├── sqlite/...
└── md/...
```

Per-process facts (from the feasibility audit):

- Each `define*Daemon().start()` calls `createMachineAuthClient()` independently. The auth lives in one OS keychain slot (`{ service: 'epicenter.auth.session', name: 'current' }`). Four concurrent instances race on refresh-token rotation; last writer wins.
- Each opens its own WebSocket to its workspace's `roomWsUrl`. No relay-side multiplexing.
- Each binds a unix socket via `socketPathFor(projectDir)`. With distinct `projectDir`s per app today, that's four sockets. With one `projectDir` it would be one socket already.
- Each holds a Y.Doc with `gc: false` and the full history loaded. RAM scales with workspace age.

The CLI (`packages/cli/src/load-config.ts:251-278` `startDaemonRoutes`) already iterates an array of `DaemonRouteDefinition`s and starts each in sequence. The Hono app multiplexes their `/run`, `/list`, `/peers` endpoints. **The multi-tenancy is mostly built.**

## Target state

```
$ ps aux | grep bun
braden  ...  epicenterd        ← single process

~/Project/epicenter.config.ts
  defineConfig({
    daemon: {
      routes: [
        defineFujiRoute(),
        defineHoneycrispRoute(),
        defineOpensidianRoute(),
        defineZhongwenRoute(),
      ],
    },
  })

~/Project/.epicenter/
├── daemon.sock          ← one socket, all four workspaces reachable
├── yjs/...
├── sqlite/...
└── md/...
```

A script invokes `daemon.fuji.entries_update(...)` or `daemon.honeycrisp.tag_note(...)` through a single `connectDaemonActions` proxy because the `/run` dispatcher already prefixes by route name.

## The fixes

### 1. Share the auth client (real bug)

Today four `createMachineAuthClient()` calls race on one keychain slot. Even with N=2 this can cause refresh-token desync.

Fix shape:

```ts
// packages/workspace/src/daemon/types.ts
export type DaemonRouteDefinition = {
  route: string;
  start(input: {
    projectDir: ProjectDir;
    auth: AuthClient; // injected, not constructed inside
  }): Promise<StartedDaemonRoute>;
};

// packages/cli/src/load-config.ts startDaemonRoutes
const auth = await createMachineAuthClient(); // once
for (const def of definitions) {
  await def.start({ projectDir, auth });
}
```

Each app's `define*Daemon().start()` stops calling `createMachineAuthClient()` and consumes the injected client. `session = requireSession(auth)` and `session.encryptionKeys` / `session.openWebSocket` flow from the single instance.

This is the only architectural change with a real correctness payoff. Worth doing even if the rest stays per-process.

### 2. Single-config consolidation

Instead of each app having its own `epicenter.config.ts`, the root project has one config that lists all routes:

```ts
// epicenter.config.ts at the project root
import { defineConfig } from '@epicenter/workspace/daemon';
import { defineFujiRoute } from '@epicenter/fuji/daemon';
import { defineHoneycrispRoute } from '@epicenter/honeycrisp/daemon';
// ...

export default defineConfig({
  daemon: {
    routes: [defineFujiRoute(), defineHoneycrispRoute(), ...],
  },
});
```

`epicenter daemon up -C <projectRoot>` reads this and starts all four routes inside one process bound to one unix socket. No change to `buildDaemonApp` needed; it already multiplexes routes.

Per-app `epicenter.config.ts` files can still exist for app-isolated dev workflows, but the production shape is one root config.

### 3. WebSocket sharing (open question, defer)

Today: one WebSocket per workspace per machine. With one daemon and four workspaces, that's four sockets from one process.

Relay-side multiplexing (one WebSocket carrying messages for many workspaces) is doable but requires a protocol change. Don't do it now. Four sockets at typical workspace counts is fine. Revisit if a user hits the relay's per-IP connection cap or if mobile bandwidth becomes a concern.

### 4. Lifecycle UX

The CLI's `upCommand` (`packages/cli/src/commands/up.ts:210`) parks the process with `process.stdin.resume()` and is "foreground by design." For a single-daemon world, three lifecycle scenarios:

- **Headless server / CI / cron**: user runs `epicenter daemon up -C ~/Project` in a tmux pane or under launchd / systemd. Unchanged.
- **Desktop app (Tauri Whispering or future Tauri shell)**: the desktop app spawns `epicenterd` as a child process, pipes its logs, and tears it down on app quit. The desktop app is the lifecycle manager. Same binary, different parent.
- **One-shot script**: `epicenter run ./my-script.ts` boots a daemon if one isn't running, runs the script against it, and either tears down or leaves it running based on a flag. CLI affordance, not a daemon change.

This spec recommends shipping (1) and (2) as the supported flows; (3) can come later.

### 5. Naming pass

`defineFujiDaemon` is misleading: it doesn't define a daemon, it defines a workspace route on a daemon. Once the multi-tenant shape is the norm, rename:

- `defineFujiDaemon` -> `defineFujiRoute` (or `defineFujiWorkspaceRoute` if collision risk).
- Symmetric for Honeycrisp, Opensidian, Zhongwen.
- `apps/<app>/blocks/daemon-route.ts` already uses the right filename. The exported function is the only thing to rename.

Do this after the auth-injection refactor lands; it's a clean-break naming move that touches every app.

## Phased migration

**Phase 0 (this spec):** decision recorded, no code changes.

**Phase 1: shared auth client.** Smallest, highest-correctness change. Inject `auth` into `DaemonRouteDefinition.start()`. Update each `define*Daemon()` to consume the injected client. Bonus: write a regression test that two routes in one process don't race on keychain writes.

Implementation note: branch `codex/daemon-shared-auth` injects a single `AuthClient` from `startDaemonRoutes()` into every route start context. Fuji, Honeycrisp, Opensidian, and Zhongwen now consume the injected client instead of calling `createMachineAuthClient()` inside their route factories. `startDaemonRoutes()` still accepts an explicit auth client for tests so config-loader tests do not require a persisted machine session.

**Phase 2: root config + naming pass.** Land single-`epicenter.config.ts` at the project root listing all routes. Rename `define*Daemon` to `define*Route`. Update CLI docs.

**Phase 3: lifecycle integration.** Wire Tauri shell (or whichever desktop app exists) to spawn `epicenterd` as a child. Document the headless tmux / systemd workflow. Add a `--background` flag or document `nohup` patterns.

**Phase 4 (optional, deferred):** relay-side WebSocket multiplexing. Only if connection budget becomes a real constraint.

## Risk register

- **Phase 1 risk**: an app outside the four (e.g., a third-party `epicenter/<app>/daemon-route` consumer) constructs its own auth client. The `DaemonRouteDefinition.start` signature change is breaking; recipe consumers have to update one line. Acceptable: jsrepo blocks are consumer-owned.
- **Phase 2 risk**: dev workflows that rely on per-app `epicenter.config.ts` (e.g., running just Fuji's daemon for an isolated test) need a documented opt-in. Keep the per-app config as a supported pattern.
- **WebSocket count**: at 10 workspaces, one process opens 10 WebSockets. Hitting OS FD limits is unlikely (256 default on macOS, configurable) but worth a smoke test.

## Open questions

- **What about Whispering's existing daemon?** Whispering uses Tauri, not the Bun daemon. It does not participate in this consolidation. Confirm scope: `epicenterd` is the consolidation target for the SvelteKit apps (Fuji, Honeycrisp, Opensidian, Zhongwen), not for Tauri-shell apps.
- **`epicenter run ./script.ts` (auto-start scripts)?** Out of scope here, captured in the script-surfaces resolution spec.
- **Sandboxing for AI-generated scripts?** Out of scope. The daemon-as-singular-writer is a prerequisite for sandboxing (it's where invariant enforcement, dry-run, audit log live), but the sandbox itself is a separate spec.

## Verification

Phase 1 (shared auth):

```bash
# All four define*Daemon factories must accept injected auth
rg -A 4 "start.*projectDir.*auth" packages/workspace/src/daemon/types.ts apps/*/blocks/daemon-route.ts

# No app calls createMachineAuthClient inside its define*Daemon
rg "createMachineAuthClient" apps/*/blocks/daemon-route.ts # expect 0 matches
```

Phase 2 (root config + naming):

```bash
# Root config exists and lists all routes
test -f epicenter.config.ts && grep -c "Route()" epicenter.config.ts # expect >= 4

# Old name gone
rg "defineFujiDaemon|defineHoneycrispDaemon|defineOpensidianDaemon|defineZhongwenDaemon" # expect 0

# Bun.serve binds one unix socket for the project
ls -la ~/Project/.epicenter/daemon.sock
```
