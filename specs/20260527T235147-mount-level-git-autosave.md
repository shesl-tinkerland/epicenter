# Materializer-Owned Git Autosave

**Date**: 2026-05-27
**Updated**: 2026-05-28
**Status**: Implemented
**Owner**: Braden
**Supersedes**: the current uncommitted `defineProject` and project-level autosave experiment, and the earlier mount-level `attachGitAutosave` draft of this spec

## One Sentence

Git autosave lives inside `attachMarkdownMaterializer` as an optional `git` option, so the materializer that owns the disk writes also owns committing them, and every layer above (mount, daemon, project config) loses a concept.

## How To Read This Spec

Read first:

```txt
One Sentence
Current Decision
Target Shape
API Contract
Implementation Plan
Verification
```

Read if debating the architecture:

```txt
Philosophy
Design Decisions
Rejected Alternatives
Edge Cases
Bun.$ vs Bun.spawn
```

## Current Decision

The grill collapsed twice:

```txt
1. project-level   defineProject({ mounts, git })            <- previous experiment
2. mount-level     fuji({ git }) + attachGitAutosave(...)    <- previous draft of this spec
3. materializer    attachMarkdownMaterializer({ git })        <- this spec
```

Each step deletes more code than it adds. The materializer is the only thing that knows the file paths it just wrote, owns the directory those files live in, and already runs its disposal hook on `ydoc.once('destroy', ...)`. Putting git inside it removes:

```txt
delete defineProject
delete Project
delete ProjectGitConfig
delete MountOutput
delete DaemonRuntime.outputs
delete outputs: [markdown] in every mount
delete the third loadProjectConfig shape
delete the runUp autosave branch
delete daemon/autosave/ entirely
delete a separate attachGitAutosave file
delete public MaterializerWriteEvent and WriteListener types
delete materializer.onWrite public method
```

Accepted costs:

```txt
cost: git child processes spawn from inside the materializer file (Bun.$)
cost: per-materializer commits instead of one project-wide commit
cost: per-mount git config duplication when users want shared settings
cost: best-effort shutdown (SIGTERM may drop last batch if git is slow)
benefit: one option on one existing attach call replaces an entire feature stack
```

The user has explicitly confirmed:

```txt
best-effort shutdown is fine
multiple commits per quiet window is fine
index.lock contention is fine (one retry, then accept loss to working tree)
```

## Philosophy

The right boundary is where the file paths live.

```txt
markdown materializer owns:
  - a directory on disk
  - the row -> file mapping
  - the lifecycle of those files (write, unlink, rebuild)
  - dispose hook on ydoc.destroy

git autosave needs:
  - which files just changed       <- only the materializer knows
  - a working directory for git    <- the materializer already has `dir`
  - a debounce policy              <- config
```

Everything autosave needs is already inside the materializer's closure. Exposing it as an event so a separate consumer can subscribe is the "cross-cutting concern" framing. There is no cross-cutting; there is one source and one sink. The honest framing is **version control is a sub-concern of the materializer**.

Greenfield rule applied three times:

```txt
Would we add defineProject in a clean repo?
  No. Mount[] already describes daemon input.

Would we add a separate attachGitAutosave subscribing via onWrite?
  No. The materializer is the only source. The event API is plumbing for a fan-out that does not exist.

Would we add onWrite as a public capability at all?
  No, if the materializer commits its own writes.
```

## Current State

The worktree currently adds a project-level autosave path:

```txt
epicenter.config.ts
  -> default export Project | Mount | Mount[]

loadProjectConfig()
  -> Project { mounts, git? }

runUp()
  -> startProjectMounts(project.mounts)
  -> if project.git.autosave startAutosaveService(...)

mount runtime
  -> outputs?: MountOutput[]

startAutosaveService()
  -> subscribe to every runtime.output.onWrite()
  -> stage all observed paths
  -> commit at the project root
```

Files in the current experiment:

```txt
packages/workspace/src/config/define-project.ts
packages/workspace/src/config/load-project-config.ts
packages/workspace/src/config/project-config-source.ts
packages/workspace/src/daemon/types.ts
packages/workspace/src/daemon/autosave/autosave-service.ts
packages/workspace/src/daemon/autosave/autosave-service.test.ts
packages/cli/src/commands/up.ts
apps/fuji/project.ts
apps/honeycrisp/project.ts
apps/tab-manager/project.ts
```

This proves the implementation works, but the ownership is wrong twice over: the daemon should not understand outputs, and the materializer should not need to expose an event to a sibling helper.

## Target Shape

Project config returns a mount list.

```ts
import { fuji } from "@epicenter/fuji/project";

export default [fuji()];
```

Multi-mount projects return an array.

```ts
import { fuji } from "@epicenter/fuji/project";
import { honeycrisp } from "@epicenter/honeycrisp/project";

export default [fuji(), honeycrisp()];
```

Git autosave is configured per markdown materializer call. The mount factory threads `opts.git` straight into `attachMarkdownMaterializer`.

```ts
const author = { name: "me", email: "me@example.com" };

export default [fuji({ git: { author } }), honeycrisp({ git: { author } })];
```

Inside the mount, Git is one option on the markdown materializer. No separate attach call.

```ts
export type FujiMountOptions = {
  markdownDir?: string;
  sqliteFile?: string;
  git?: GitAutosaveConfig;
};

export function fuji(opts: FujiMountOptions = {}) {
  return defineMount({
    name: "fuji",
    open(ctx) {
      const workspace = createFujiWorkspace({ keyring: ctx.keyring });
      workspace.ydoc.clientID = ctx.yDocClientId;

      const sqlite = attachBunSqliteMaterializer(workspace, {
        filePath:
          opts.sqliteFile ?? sqlitePath(ctx.projectDir, workspace.ydoc.guid),
      });

      const markdown = attachMarkdownMaterializer(workspace, {
        dir:
          opts.markdownDir ?? markdownPath(ctx.projectDir, workspace.ydoc.guid),
        perTable: { entries: { filename: slugFilename("title") } },
        git: opts.git,
      });

      const infrastructure = attachProjectSync(workspace.ydoc, {
        mount: ctx.mount,
        projectDir: ctx.projectDir,
        ownerId: ctx.ownerId,
        openWebSocket: ctx.openWebSocket,
        onReconnectSignal: ctx.onReconnectSignal,
        actions: workspace.actions,
      });

      return defineWorkspace({
        ...workspace,
        ...infrastructure,
        markdown,
        sqlite,
      });
    },
  });
}
```

The daemon host stays boring:

```txt
loadProjectConfig(projectDir)
  -> Mount[]

runUp()
  -> startProjectMounts({ mounts })
  -> startDaemonServer({ mounts })
```

No daemon-level git branch. No output registry. No project wrapper. No separate attachment file.

## API Contract

### Config Loader

`loadProjectConfig(projectDir)` accepts exactly one default export shape:

```ts
export default [fuji(), honeycrisp()];
```

It returns:

```ts
Promise<Result<Mount[], ProjectConfigError>>;
```

The default generated config returns an empty array. It does not import `defineProject`.

### Markdown Materializer Git Option

`git` is optional. Presence enables autosave; omission disables it.

```ts
export type GitAutosaveConfig = {
  author?: { name: string; email: string };
  quietMs?: number;
  maxBatchMs?: number;
};

export function attachMarkdownMaterializer<TTables extends TablesRecord>(
  workspace: { ydoc: Y.Doc; tables: TTables },
  options: {
    dir: string | (() => MaybePromise<string>);
    perTable?: PerTableConfig<TTables>;
    waitFor?: Promise<unknown>;
    log?: Logger;
    git?: GitAutosaveConfig;
  },
): MarkdownMaterializer;
```

Behavior when `git` is present:

```txt
on attach:
  check `git rev-parse --is-inside-work-tree` from `dir`
  if not in a repo, log once, skip all autosave wiring (no error)
  otherwise continue

on each successful writeFile or unlink (initial flush and ongoing):
  add the absolute path to a Set<string> of dirty paths
  clear and reschedule the quiet timer (default 5s)
  if no max-batch timer is running, start one (default 60s)

on quiet or max-batch timer fire:
  drain the Set
  if empty, exit
  git add -- <paths>           cwd=dir
  git -c user.name -c user.email -c commit.gpgsign=false commit --no-gpg-sign -m "Autosave (N changes)"
  on commit exit 1 with "nothing to commit" in stderr: silent skip
  on any other non-zero: log.warn(stderr), do not retry
  retry once on .git/index.lock contention (250ms delay)

on ydoc destroy:
  no autosave action
  (see "Shutdown semantics" below for why)
```

Shutdown semantics (grounded via DeepWiki on `yjs/yjs`):

```txt
ydoc.once('destroy', listener) fires SYNCHRONOUSLY during ydoc.destroy().
Yjs does NOT await Promises returned from destroy listeners.
The document is already marked isDestroyed when listeners run.
Calling destroy() twice fires listeners twice (no idempotency guard).

Therefore: registering `ydoc.once('destroy', () => stageAndCommit())` is
mostly cosmetic. The JS event loop almost always exits before the spawned
git child processes finish their await chain. Spawned children survive
parent death on POSIX, so `git add` may complete; the JS-side `await add`
→ `git commit` sequencing usually does not.

We do not register a destroy hook. The honest contract is:
  - quietMs and maxBatchMs timer fires: reliably commit.
  - in-flight dirty Set at shutdown: NOT committed at shutdown.
  - next daemon startup: materializer re-flushes every row, every path
    re-enqueues, the first quietMs fires, the lost batch lands.

The Yjs persistence layer (attachIndexedDb / attachLogPersistence) is
the actual durability layer for workspace state. Markdown commits are a
derived history. Shutdown does not need to flush autosave to preserve user
work; it only needs to flush autosave to make `git log` complete on the
shutdown side. Re-materialization on startup provides that completeness
on the startup side instead.
```

Defaults destructured on one line after the `if (opts.git)` guard:

```ts
if (options.git) {
  const {
    author: { name = "Autosave", email = "autosave@epicenter.local" } = {},
    quietMs = 5_000,
    maxBatchMs = 60_000,
  } = options.git;
  // ... wire timers, dirty Set, stageAndCommit
}
```

Author defaults to `Autosave <autosave@epicenter.local>` deliberately. The synthetic email never matches a verified GitHub account, so autosave commits do not show in the user's contribution graph and do not display their avatar. Users override via `git.author` if they want their identity attached.

### Materializer Return Type

`onWrite`, `MaterializerWriteEvent`, and `WriteListener` are removed from the public surface. They become private internals of the materializer.

```ts
export type MarkdownMaterializer = ReturnType<
  typeof attachMarkdownMaterializer
>;
// { whenFlushed, push, pull, rebuild }
```

If a future feature genuinely needs an external write subscriber, restore `onWrite` then. Do not pre-expose it.

### Removed Surfaces

```txt
packages/workspace/src/config/define-project.ts                  delete
packages/workspace/src/daemon/autosave/                          delete
type Project, ProjectGitConfig, MountOutput                      delete
DaemonRuntime.outputs                                            delete
MaterializerWriteEvent, WriteListener (exported types)           delete
attachMarkdownMaterializer(...).onWrite                          delete (becomes internal emit only)
DEFAULT_PROJECT_CONFIG_SOURCE: `defineProject` reference          replace with `export default []`
runUp autosave branch                                            delete
startAutosaveService, AutosaveService, attach-git-autosave.ts    do not create
@epicenter/workspace/git subpath                                 do not create
```

## Bun.$ vs Bun.spawn

Grounded via DeepWiki (`oven-sh/bun`). Findings:

```txt
Bun.$
  - auto-escapes arguments in ${} (strings = one arg, arrays = expanded args)
  - throws ShellError on non-zero by default; .nothrow() suppresses
  - returns { stdout, stderr, exitCode } from await
  - .env(obj) merges env per command
  - .cwd(dir) sets working directory
  - .quiet() suppresses terminal streaming
  - footgun: git diff --quiet exits 1; without .nothrow() it throws
  - runs through an in-process Zig shell interpreter; overhead is marginal
```

Use Bun.$ for this implementation. It removes the `runGit` helper and shrinks every git call to one line:

```ts
const add = await $`git add -- ${paths}`.cwd(dir).nothrow().quiet();
if (add.exitCode !== 0) {
  log.warn(`autosave add failed: ${add.stderr.toString()}`);
  return;
}

const commit =
  await $`git -c commit.gpgsign=false commit --no-gpg-sign -m ${message} -- ${paths}`
    .cwd(dir)
    .env({
      ...process.env,
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
    })
    .nothrow()
    .quiet();

if (commit.exitCode === 0) return;
if (commit.stderr.toString().includes("nothing to commit")) return;
log.warn(`autosave commit failed: ${commit.stderr.toString()}`);
```

Pattern notes (grounded via DeepWiki on `oven-sh/bun`):

```txt
inline `git -c user.name=${name}` passes "user.name=Alice" as ONE shell arg
inline interpolation auto-escapes shell-meta characters (no injection)
pre-building `key=value` strings is NOT required for safety
```

Identity override uses env vars only (`GIT_AUTHOR_*`, `GIT_COMMITTER_*`). Env vars take precedence over both `-c` config and the repo's `.git/config`, so we do NOT need `-c user.name=...` or `-c user.email=...` flags. The only `-c` flag we keep is `-c commit.gpgsign=false` because there is no env-var equivalent for it. The `--no-gpg-sign` flag is redundant with the `-c` but belt-and-suspenders for older git versions.

Path-limited commit (`-- ${paths}`) is the canonical safe form (see "Staged-isolation invariant" below).

## Implementation Plan

- [x] **1. Restore project config to mount-only shapes.**
  - Delete `packages/workspace/src/config/define-project.ts`.
  - Keep `loadProjectConfig` accepting `Mount[]` only.
  - Revert `DEFAULT_PROJECT_CONFIG_SOURCE` to `export default []` with a comment showing `[fuji()]` as the example.
  - Update `load-project-config.test.ts` to drop the `Project` shape.

- [x] **2. Remove daemon output plumbing.**
  - Delete `type MountOutput` from `packages/workspace/src/daemon/types.ts`.
  - Delete `outputs?: ReadonlyArray<MountOutput>` from `DaemonRuntime`.
  - Remove `outputs: [markdown]` from `defineWorkspace(...)` in `apps/fuji/project.ts`, `apps/honeycrisp/project.ts`, `apps/tab-manager/project.ts`.

- [x] **3. Delete the daemon autosave service.**
  - Delete `packages/workspace/src/daemon/autosave/` entirely (service, test, index).
  - Remove the autosave re-exports from `packages/workspace/src/daemon/index.ts` and `packages/workspace/src/node.ts`.
  - Remove the `if (project.git && project.git.autosave) startAutosaveService(...)` block in `packages/cli/src/commands/up.ts`.

- [x] **4. Add the git option inside `attachMarkdownMaterializer`.**
  - Extend the options object with `git?: GitAutosaveConfig`.
  - On attach, if `opts.git` is present, one-line destructure with defaults:
    ```ts
    const {
      author: { name = "Autosave", email = "autosave@epicenter.local" } = {},
      quietMs = 5_000,
      maxBatchMs = 60_000,
    } = options.git;
    ```
  - Run `git rev-parse --is-inside-work-tree` (cwd=baseDir, nothrow, quiet); if exit code is non-zero, log once and skip autosave wiring.
  - Maintain a `Set<string>` of dirty absolute paths, two timers (`quietTimer`, `maxBatchTimer`), and a private `enqueueWrite(absPath)` helper.
  - Inside the existing `emitWrite(event)` body, after the listener-fan-out (which becomes a no-op if we delete public `onWrite`), call `enqueueWrite(event.path)`.
  - Do NOT hook `ydoc.once('destroy', ...)` for autosave. The hook is sync fire-and-forget per DeepWiki on `yjs/yjs`; spawning a git commit from it almost always loses the in-flight batch. Recovery happens via next-startup re-materialization instead.
    > Note: implementation also enqueues `pull()` and `rebuild()` writes, because they are materializer-owned file mutations too.

- [x] **5. Use `Bun.$` for git.**
  - Import via `import { $ } from 'bun'`.
  - One `git rev-parse --is-inside-work-tree` precheck.
  - Inline `git add` and `git commit` calls inside `stageAndCommit`.
  - Single retry on stderr containing `index.lock` with 250ms delay.
  - Treat commit exit 1 with `nothing to commit` in stderr as a silent skip.
    > Note: implementation checks stdout and stderr for no-diff text because Git prints this path to stdout in common cases.

- [x] **6. Remove public `onWrite` from the markdown materializer return.**
  - Delete the `onWrite(listener): () => void` method from the return object.
  - Delete the exported types `MaterializerWriteEvent` and `WriteListener`.
  - Keep the internal `emitWrite` only so the existing observer call sites continue to drive `enqueueWrite`.

- [x] **7. Wire git into each mount that has markdown.**
  - Add `git?: GitAutosaveConfig` to `FujiMountOptions`, `HoneycrispMountOptions`, and `TabManagerMountOptions`.
  - Pass `git: opts.git` directly to `attachMarkdownMaterializer`.
  - Re-export `GitAutosaveConfig` from `@epicenter/workspace/document/materializer/markdown` so apps do not import from a deep path.

- [x] **8. Simplify `runUp`.**
  - Drop the autosave branch.
  - `runUp` now only: claim lease, build auth, load project, start mounts, register runtime disposal, start daemon server, write metadata.

- [x] **9. Tests.**
  - Move the autosave-service tests into `packages/workspace/src/document/materializer/markdown/git.test.ts` (or similar) and rewrite them to drive `attachMarkdownMaterializer` against a real temp directory inside a real `git init` repo.
  - Drop tests that asserted multi-mount coalescing into one commit.
  - Drop the `path-escapes-projectDir` test (materializer owns its dir).
  - Drop the mid-rebase-skip test.

## Output Contract

The "output" of this feature is the git working tree itself. The materializer writes files and commits them in one closure. There is no event surface between the two.

ASCII flow:

```txt
Y.Doc table change
  -> markdown materializer observer
  -> writeFile or unlink
  -> internal enqueueWrite(absolutePath)
  -> debounce
  -> Bun.$ git add exact paths
  -> Bun.$ git commit exact paths
```

## Design Decisions

| Decision                                                             | Class                     | Rationale                                                                                                                                                                                                                     |
| -------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Git lives inside `attachMarkdownMaterializer`                        | Greenfield refusal        | The materializer is the only source of files-to-commit. One owner, one closure, one option. No event boundary earns its keep.                                                                                                 |
| Delete `defineProject`                                               | Greenfield refusal        | A project wrapper only carried `git`. Without git at the project level, `Mount[]` is enough.                                                                                                                                  |
| Delete public `MaterializerWriteEvent` / `WriteListener` / `onWrite` | Greenfield refusal        | Existed to ferry data to an external subscriber. No external subscriber exists.                                                                                                                                               |
| Use `Bun.$` instead of `Bun.spawn`                                   | Implementation simplicity | Auto-escaped paths, chainable env/cwd/nothrow/quiet, inline call sites. Removes the `runGit` helper. Marginal overhead, negligible for git invocations.                                                                       |
| No destroy hook; rely on next-startup re-materialization             | Evidence                  | Per DeepWiki on `yjs/yjs`, destroy listeners are sync fire-and-forget; Yjs never awaits returned promises. Spawning git from the hook is mostly cosmetic. Re-materialization on next attach naturally re-enqueues lost paths. |
| Drop mid-rebase/merge/cherry-pick detection                          | Greenfield refusal        | "Files must land" wins over "do not interfere with interactive git." Commit fails -> log -> files remain on disk -> user recovers. ~25 LOC saved.                                                                             |
| Drop `hasStagedChanges` precheck                                     | Implementation simplicity | `git commit` exits 1 with "nothing to commit" on empty staging. Match that stderr and silent-skip. ~25 LOC saved.                                                                                                             |
| Drop `inFlight: Promise<void>` serialization                         | Implementation simplicity | `drainDirty()` is atomic. Concurrent flushes from the same materializer race the index lock; the retry handles it. ~10 LOC saved.                                                                                             |
| Drop path-escapes-projectDir guard                                   | Implementation simplicity | The materializer owns `dir`. It cannot emit paths outside its own tree.                                                                                                                                                       |
| `Set<string>` instead of `Map<string, DirtyEntry>`                   | Implementation simplicity | No mount accounting, no write/unlink distinction in the commit message.                                                                                                                                                       |
| Author default: `Autosave <autosave@epicenter.local>`                | Privacy + UX              | Synthetic email never matches a verified GitHub account: no contribution graph entries, no avatar leak. Users override if they want their identity.                                                                           |
| Run `git rev-parse --is-inside-work-tree` once at attach time        | Defensive minimum         | Avoids log-spam when the project is not in a repo. Three lines.                                                                                                                                                               |
| Single retry on `.git/index.lock` (250ms)                            | Taste under constraints   | Multi-materializer concurrency is rare but real. One retry covers it without hot-looping.                                                                                                                                     |
| Keep `quietMs` and `maxBatchMs`                                      | Invariant                 | "Files must land" requires both debouncing (so we do not commit-spam) and a periodic force-flush (so an active writing session does eventually persist).                                                                      |
| Do not add a generic `onAfterWrite` hook to the materializer         | Greenfield refusal        | One sink, internal. Adding a public hook for a hypothetical second sink is the trap we just escaped.                                                                                                                          |
| Do not add `.withGitAutosave()` builder                              | Greenfield refusal        | Mount factories are plain calls; chaining hides lifecycle order.                                                                                                                                                              |
| Do not put git on the SQLite materializer                            | Scope                     | SQLite output is binary and `.epicenter/`-gitignored. Not a git-tracked artifact.                                                                                                                                             |

## Rejected Alternatives

### `defineProject({ mounts, git })`

Refusal:

```txt
A project wrapper only carries one optional integration.
That integration can be a per-materializer option instead.
```

User loss:

```txt
No single top-level git option shared by all mounts.
```

Why acceptable:

```txt
Config can share a local const:
  const git = { author };
  export default [fuji({ git }), honeycrisp({ git })];
```

Trigger to revisit:

```txt
A real project-level product object appears with operations that cannot live on a mount or materializer.
```

### Mount-level `attachGitAutosave(workspace, { materializer, ... })`

Refusal:

```txt
The materializer is the only source.
An external subscriber requires a public onWrite event.
The event is plumbing for a fan-out that does not exist.
```

User loss:

```txt
No way to attach git to a hypothetical non-markdown source via the same helper.
```

Why acceptable:

```txt
There is no second source today. When one appears, that source can either commit itself or expose its own event.
```

Trigger to revisit:

```txt
A second concrete writer (JSON, CSV, anything) needs identical git semantics AND must share a debouncer with markdown. Until both are true, per-source git remains cleaner.
```

### Daemon `outputs[]`

Refusal:

```txt
Every runtime would expose a generic disk output for one feature.
```

User loss:

```txt
No central autosave service that batches every mount into one commit.
```

Why acceptable:

```txt
Per-materializer commits are clearer for `git log -- <subdir>`.
```

Trigger to revisit:

```txt
Two or more daemon-level integrations need to discover materialized outputs across all mounts.
```

### Git inside `attachMarkdownMaterializer` (this spec)

Previously rejected on the grounds that "markdown materialization should not know about git." Reversed.

Why reversed:

```txt
The markdown materializer already owns:
  - the directory
  - the file paths it writes
  - the disposal hook

Git only needs those three facts.
Externalising via an event makes the materializer "report" what it already controls.
The honest framing is that version control is a sub-concern of the materializer that produces the version-controlled files.
```

What we are paying:

```txt
The markdown materializer file gains git knowledge.
It spawns child processes via Bun.$.
It becomes Bun/Node-only on the git code path (already true in practice).
```

What we get:

```txt
Net deletion across the stack:
  - defineProject, Project, ProjectGitConfig
  - MountOutput, outputs[]
  - daemon/autosave/ folder
  - separate attach-git-autosave.ts
  - public MaterializerWriteEvent / WriteListener / onWrite
  - runUp autosave branch
  - third loadProjectConfig shape
```

### `git: true` instead of `git: {}`

Refusal:

```txt
Bool forces a breaking change the moment a user wants `git: { quietMs: 1000 }`.
```

Cost of choosing object:

```txt
Two extra characters per use site.
```

### Required `git` option on the markdown materializer

Refusal:

```txt
Scripts, sandboxes, tests, and CI runners materialize markdown without wanting a git child process spawned.
```

Cost of optional:

```txt
One `if (options.git)` guard at the top of the autosave block.
```

### Expose `flushAutosave()` / `whenAutosaved` on the materializer

Refusal:

```txt
Best-effort shutdown is acceptable per the user's stated invariant.
The +5-6 LOC handle plus daemon-side await is not earned today.
```

Trigger to revisit:

```txt
A reproducible workflow where SIGTERM regularly drops a batch that the user later realizes is missing.
Then add `whenAutosaved: Promise<void>` and have the daemon await it during teardown.
```

## Edge Cases

Two materializers in one project (e.g. fuji + honeycrisp both with `git: {}`):

```txt
Each has its own dirty Set, its own timers, its own stageAndCommit.
Two git invocations may race for .git/index.lock.
First retries; if still locked, log and drop this batch.
Lost batch's files remain on disk; user can git add them.
```

User has staged unrelated work (grounded via DeepWiki on `git/git`):

```txt
git commit -- <paths> is documented as identical to git commit --only -- <paths>.
The --only mode is the DEFAULT whenever paths are given on the command line.
A pre-staged unrelated foo.txt stays staged AND is NOT in the autosave commit.
This is verified in git's own test suite.

INVARIANT: autosave commits contain exactly the paths it stages.
The user's pre-staged work is left alone.
No stash-keep-index dance, no temporary index, no isolation hack.
```

Subtlety worth noting: `--only` reads file contents from the WORKING TREE, not the index. For our case (autosave's own `git add` immediately followed by `git commit` with the same paths and no concurrent edits), working tree and index match. No bug.

User mid-merge / rebase / cherry-pick:

```txt
`git commit` may refuse or may succeed with a merge-commit shape.
On refusal: stderr is logged, files remain on disk, user resolves the rebase, next quiet window retries.
On success: a stray autosave commit appears mid-rebase. User squashes during interactive cleanup.
We do not pre-check git state.
```

Materializer's `dir` is not inside a git repo:

```txt
Precheck (`git rev-parse --is-inside-work-tree`) fails.
Log once: "git autosave: not in a git repo; skipping".
Do not wire timers. Do not enqueue.
Materializer still writes files normally.
```

Daemon shuts down before the quiet window:

```txt
No destroy hook is registered (see Shutdown semantics).
The in-flight dirty Set is lost.
Files remain on disk (the materializer's writes already completed sync).
On next daemon up:
  the materializer's initial flush rewrites every row
  every path re-enqueues
  the first quietMs after startup commits everything
The user's `git log` ends up complete; the timing is just shifted.
```

No materializer write produced a real diff (e.g., rewrote identical bytes):

```txt
git add stages nothing new.
git commit fails with exit 1 and stderr "nothing to commit, working tree clean".
Silent-skip via stderr substring match.
```

GPG signing required by user's git config:

```txt
We pass `-c commit.gpgsign=false` and `--no-gpg-sign` to override per-commit.
This does not touch the user's config.
If hooks enforce signing, the commit fails; we log; user's manual workflow is unaffected.
```

Pre-commit hooks:

```txt
We do NOT pass --no-verify by default.
Hooks run; if they fail, the commit fails and is logged.
If users want to bypass, document it as a future option, not a default.
```

## Verification

Targeted tests:

```txt
bun test packages/workspace/src/document/materializer/markdown/
bun test packages/workspace/src/config/load-project-config.test.ts
```

Type and package checks:

```txt
bun run build
```

Source cleanup checks:

```txt
rg -n "defineProject|ProjectGitConfig|MountOutput|outputs:" packages/workspace/src apps packages/cli/src
rg -n "startAutosaveService|daemon/autosave|attach-git-autosave" packages/workspace/src packages/cli/src
rg -n "MaterializerWriteEvent|WriteListener|onWrite" packages/workspace/src
```

The first two should return zero source matches. The third should match only internal materializer code, not exported types or app-side subscribers.

Required behavioral tests (real temp git repo, real materializer):

```txt
commits one batch after quietMs
forces a batch after maxBatchMs
does nothing when no writes occurred
uses the configured author without mutating .git/config
defaults to Autosave <autosave@epicenter.local> when no author is provided
does not push
silent-skips when commit produces no diff ("nothing to commit")
logs and skips when dir is not inside a git repo
retries once on .git/index.lock and accepts loss if still locked
does NOT register a destroy hook (assert no listener subscribes to ydoc destroy for autosave)
re-materialization on subsequent attach re-enqueues all paths and commits them
honors `git: undefined` by wiring zero timers and not running git
```

Tests dropped from the previous draft:

```txt
project-level multi-mount one-commit coalescing (no longer the behavior)
path-escapes-projectDir guard (no longer applicable)
mid-rebase/merge/cherry-pick skip (no longer a behavior)
hasStagedChanges precheck (replaced by commit-time stderr match)
```

## Done Criteria

```txt
epicenter.config.ts accepts only Mount[]
attachMarkdownMaterializer accepts opts.git
git: {} enables autosave with all defaults
git: undefined disables autosave entirely (zero overhead)
omitted git: undefined and never spawns git child processes
runUp has no autosave branch
daemon runtime has no outputs field
defineProject / Project / ProjectGitConfig files and exports are gone
MountOutput type and outputs:[] are gone
daemon/autosave/ folder is gone
public MaterializerWriteEvent / WriteListener / onWrite are gone
no @epicenter/workspace/git subpath exists
Bun.$ is used for git invocations (no `runGit` helper)
tests prove the one-batch-per-quiet-window invariant
tests prove the not-in-repo silent skip
tests prove author default is the synthetic identity
```

## Implementation Notes

Tab Manager git option:

```txt
Tab Manager materializes bookmarks, devices, and savedTabs as markdown.
It accepts the same `git` option as Fuji and Honeycrisp.
It does not enable Git autosave by default; users opt in with `tabManager({ git })`.
```

Retry delay:

```txt
250ms fixed delay on .git/index.lock.
Add backoff or jitter only after observation shows real lock-storms.
```

Commit message:

```txt
Default: "Autosave (N changes)"
N is the number of distinct paths in the batch.
Per-table breakdown was dropped; if users complain, add a body line listing tableNames.
```

Bun import:

```txt
Top-level `import { $ } from 'bun'`.
This makes the markdown materializer file Bun-only at module load even when git is unused.
Acceptable because the materializer runs inside the daemon, which is already Bun-only.
If a non-Bun consumer ever needs the materializer, the git block can lazy-import.
```

Pre-commit hooks bypass:

```txt
Default: hooks run.
Possible future option: `git: { skipHooks: true }` passes --no-verify.
Do not add until requested.
```

## Review

**Completed**: 2026-05-28
**Branch**: main

### What Landed

Git autosave now lives inside `attachMarkdownMaterializer({ git })`. The config loader returns `Mount[]`, generated configs default to `export default []`, the daemon no longer sees project git config or output registries, and mount factories pass their `git` option straight into the markdown materializer.

The public markdown materializer surface is now `{ whenFlushed, push, pull, rebuild }`. `MaterializerWriteEvent`, `WriteListener`, and `onWrite` are private implementation details again.

### Deviations and Discoveries

- `pull()` and `rebuild()` now enqueue git autosave too. They are materializer-owned writes, so excluding them would leave a surprising gap.
- The no-diff skip checks stdout and stderr. Git commonly prints "nothing to commit" style messages to stdout for path-limited commits.
- Type-checking `runUp` exposed an unrelated but real inference hole in `openCollaboration.dispatch`; the implementation always returned `Result<unknown, DispatchError>`, but TypeScript inferred `Promise<unknown>`. The return type is now explicit.
- Tab Manager follows Fuji and Honeycrisp: `git` is opt-in via `tabManager({ git })`, not enabled by default.

### Verification

```txt
PASS  bun test packages/workspace/src/document/materializer/markdown/ packages/workspace/src/config/load-project-config.test.ts
PASS  bun test packages/cli/src/commands/up.test.ts  (rerun outside sandbox because Unix socket listen returned EPERM)
PASS  bun test packages/workspace/src/document/open-collaboration.test.ts
PASS  bun x tsc --noEmit -p packages/workspace/tsconfig.json
PASS  bun x tsc --noEmit -p packages/cli/tsconfig.json
PASS  bun run --cwd apps/fuji typecheck
PASS  bun run --cwd apps/honeycrisp typecheck
PASS  bun run --cwd apps/tab-manager typecheck
PASS  cleanup grep checks for deleted public/source surfaces
FAIL  bun run build
```

`bun run build` fails before this change's packages finish because `apps/opensidian/src/lib/state/skill-state.svelte.ts` has a pre-existing Svelte parse error at line 145. The build also prints unrelated Svelte warnings in `apps/whispering` and `apps/skills`.

### Follow-up Work

- Fix the existing `opensidian` build failure so repo-wide `bun run build` can become a useful final gate again.
