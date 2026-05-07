# Realign workspace-app-layout skill with the two shipped layouts

> The skill currently leads with `apps/<app>/src/lib/<app>/{index, browser, client}.ts` as the default shape, with the route-group variant as a side note. The audit shows that's backwards: the post-spec-3 web apps (fuji, honeycrisp, zhongwen) use the route-group shape and don't have a `client.ts` at all, while the lib-singleton shape lives on in apps that haven't migrated to `createSession`. Reframe the skill around two co-equal shapes; surface `session.svelte.ts` as the singleton home for shape A.

**Date**: 2026-05-07
**Status**: Implemented (2026-05-07)
**Author**: AI-assisted, grounded in a live audit of `apps/{fuji,honeycrisp,zhongwen,opensidian,tab-manager,whispering}` post merge of `feat/encrypted-local-workspace-storage` (PR #1737, merge `770ba579a`).
**Branch**: `chore/workspace-app-layout-skill-audit`

## One-sentence thesis

```txt
Two layouts ship today; the skill should describe both as first-class
shapes and point at the real files in each, not lead with one and footnote
the other.
```

## Audit findings

```
Shape A — auth-gated SvelteKit web apps (fuji, honeycrisp, zhongwen)
  apps/<app>/src/lib/auth.ts
    └── createCookieAuth() → exported `auth`
  apps/<app>/src/lib/session.svelte.ts                    ← singleton home
    ├── createSession({ auth, build })
    ├── HMR disposal
    └── module-level getSignedInSession() helper
  apps/<app>/src/routes/(signed-in)/<app>/index.ts        ← iso factory
    └── open<App>Doc({ encryptionKeys, clientID? })
  apps/<app>/src/routes/(signed-in)/<app>/browser.ts      ← env binding
    └── open<App>({ userId, peer, bearerToken, encryptionKeys })

  No client.ts. Singleton lives in session.svelte.ts. Iso + env factories
  live under the (signed-in) route group, not src/lib/<app>/.

Shape B — module-level singleton apps (opensidian, tab-manager, whispering)
  apps/<app>/src/lib/<app>/index.ts                       ← iso factory
  apps/<app>/src/lib/<app>/{browser,extension,tauri}.ts   ← env binding
  apps/<app>/src/lib/<app>/client.ts                      ← singleton + auth wait
    ├── module-level await session.whenReady
    ├── waitForAuthState(auth, ...)
    └── module-level open<App>(...) export

  No session.svelte.ts. Auth integration is inline at module init.
```

The skill currently does mention shape A (lines 30–35: "Some SvelteKit apps scope their browser workspace to `routes/(signed-in)/`"), but as a deviation from the lib-singleton default. It should be the other way around: shape A is the post-refactor target; shape B is the legacy that opensidian/tab-manager are scheduled to migrate away from per `specs/20260507T054727-opensidian-tab-manager-create-session.md`.

## Specific gaps in current SKILL.md

```
LINE(S)            ISSUE                                                         FIX
─────────────────  ──────────────────────────────────────────────────────────    ─────────────────────────────────
13–22              Single tree shows lib/<app>/ as default, client.ts            Replace with two parallel trees,
                   "optional", routes/(signed-in)/ unmentioned                   one per shape.

30–35              Shape A described as a deviation                              Reframe as a peer shape; remove
                                                                                 "if a $lib client singleton owns
                                                                                 the auth wait" framing as fallback.

39–45 (Layers      No row for session.svelte.ts                                  Add row: "session.svelte.ts | App
table)                                                                           singleton + lifecycle | createSession,
                                                                                 auth, HMR | session export,
                                                                                 getSignedInSession()"

41–45              client.ts row reads "App singleton or auth                    Split into two rows or qualify:
                   owner ... apps not yet on createSession"                      shape A has no client.ts; shape B's
                                                                                 client.ts is the singleton.

176–230 (daemon /  Daemon and script content is correct but                      No change needed; clarify upfront
script + package   conflated with browser-singleton work                         that daemon/script factories are
exports)                                                                         shared across both shapes via the
                                                                                 cli package.

252                "Relocating client.ts during a daemon-only                    Qualify as shape-B-only; add
                   change" anti-pattern                                          shape-A equivalent ("don't move
                                                                                 createSession out of session.svelte.ts
                                                                                 during a routing change").
```

## Whispering note

Whispering is its own shape: Tauri desktop, no remote auth, no encryption keys, workspace = always-on singleton. Mentioning it as shape B is approximately right (it has `client.ts`), but the skill should call out that it doesn't pass `encryptionKeys` and doesn't have an auth path. Omit it from the migration discussion.

## Out of scope (separate specs)

- **Opensidian/tab-manager createSession migration** is its own work, already scoped at `specs/20260507T054727-opensidian-tab-manager-create-session.md`. That spec is correct post-audit:
  - Opensidian section: actionable now; migrate `client.ts` shape into `auth.ts` + `session.svelte.ts` + iso/env factories under route group. Same shape A as fuji.
  - Tab-manager section: blocked on async-construction decision (`openTabManager` is async today; `createSession.build` is sync). The spec correctly defers this; do not unblock here.
- **Tab-manager async construction** needs its own design call (sync construction + async readiness vs. an explicit `createSessionAsync` factory variant). Not unlocked by this skill rewrite.

## Execution

Single wave, single commit:

1. Edit `.claude/skills/workspace-app-layout/SKILL.md` per the gaps table above.
2. Verify by re-reading the skill cold: would an agent scaffolding a new auth-gated web app land on shape A first? Would an agent maintaining opensidian land on shape B with a clear "this is being migrated" pointer?
3. Smoke check: every file path mentioned in code blocks should resolve in the current tree (`apps/zhongwen/src/lib/zhongwen/...` references that no longer exist must be updated to `apps/zhongwen/src/routes/(signed-in)/zhongwen/...`).

## Verification

```
☐ skill leads with both shapes; neither is a side note
☐ shape A tree shows session.svelte.ts as the singleton home
☐ Layers table has a session.svelte.ts row
☐ every file path in code blocks resolves
☐ daemon/script content unchanged in substance
☐ no agent reading this fresh would scaffold a new web app under src/lib/<app>/
```

## Why this spec, not a "rewrite the skill" spec

The skill is ~70% right post-spec-3. A targeted realign earns the cleanup without committing to a full rewrite that would also need to absorb the (still-pending) tab-manager async question. If `createSession.build` becomes async-capable later, the skill grows one more variant; better to land structural fixes now than wait for a feature that may not happen.
