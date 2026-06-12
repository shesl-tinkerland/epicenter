# Matter CLI Namespace Decision

**Date**: 2026-06-10
**Status**: Accepted
**Owner**: Epicenter maintainers

## One Sentence

`epicenter` owns the shell binary; `matter` may be an Epicenter subcommand, app name, or folder protocol name, but it must not be shipped as a standalone global command.

## Overview

This note records the naming boundary for Matter, the typed markdown folder editor. The goal is to keep the product name available where it helps while avoiding a global terminal collision with the broader Matter ecosystem.

## Current State

The repo has one published CLI package:

```jsonc
// packages/cli/package.json
{
  "name": "@epicenter/cli",
  "bin": {
    "epicenter": "./bin/epicenter.mjs"
  }
}
```

The Matter app is currently private and app-scoped:

```jsonc
// apps/matter/package.json
{
  "name": "@epicenter/matter",
  "private": true
}
```

The desktop bundle presents the app as Matter:

```jsonc
// apps/matter/src-tauri/tauri.conf.json
{
  "productName": "Matter",
  "identifier": "so.epicenter.matter"
}
```

Matter also owns folder-local artifacts:

```txt
matter.json
  user and agent editable model file

matter.sqlite
  disposable read-only projection
```

Those folder names are not CLI commands. They are part of the local folder protocol and can stay.

Matter is not a workspace-backed app today. It does not expose a `defineMount`,
does not own `defineTable` tables, and does not depend on `@epicenter/workspace`.
It is a desktop folder app that watches markdown files through Tauri, interprets
`matter.json` through `@epicenter/field`, and writes a disposable
`matter.sqlite` projection for SQL readers.

## Research Findings

### Existing Global Names

The unscoped npm package `matter` already exists as a front matter parser. More importantly, `@matter/cli-tool` installs a `matter` command for the Matter smart-home protocol ecosystem. The Matter protocol itself is also a large external naming gravity well.

Sources:

- [npm: @matter/cli-tool](https://www.npmjs.com/package/%40matter/cli-tool)
- [npm registry: matter](https://registry.npmjs.org/matter/latest)
- [matter.js repository](https://github.com/matter-js/matter.js)

Key finding: a standalone `matter` executable is not technically impossible, but it would compete in the user's `$PATH` with an existing command from a larger ecosystem.

Implication: Epicenter should not publish or document a bare `matter` binary. The collision cost is not worth the convenience.

## Namespace Model

Different surfaces have different owners. Treating them as one namespace is the mistake.

| Surface | Example | Owner | Decision |
| --- | --- | --- | --- |
| Shell binary | `epicenter` | Epicenter CLI package | Keep |
| Shell binary | `matter` | Global `$PATH` | Reject |
| Epicenter subcommand | `epicenter matter check .` | `packages/cli` | Allowed |
| Workspace mount action | `epicenter run matter.entries.fix '{}'` | Project config | Not a current Matter target |
| Desktop app name | `Matter by Epicenter` | App bundle and product copy | Allowed |
| Scoped package | `@epicenter/matter` | Epicenter npm scope | Allowed |
| Unscoped package | `matter` | npm public package namespace | Reject |
| Folder protocol file | `matter.json` | Matter folder model | Keep |
| Folder projection file | `matter.sqlite` | Matter folder projection | Keep |

Rule:

```txt
Bare command:
  matter
  -> rejected

Epicenter grammar:
  epicenter matter ...
  -> allowed

Workspace action grammar:
  epicenter run matter.some_action ...
  -> allowed only if a future project defines a Matter mount

Product copy:
  Matter by Epicenter
  -> allowed
```

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Global executable | 1 evidence | Do not ship `matter` | Existing external `matter` command and Matter smart-home ecosystem make this a predictable collision. |
| CLI owner | 2 coherence | Keep `epicenter` as the only global Epicenter command | The CLI is the platform surface. App-specific affordances live underneath it. |
| Matter CLI family | 2 coherence | Use `epicenter matter ...` if Matter needs direct commands | This reserves `matter` only inside the Epicenter command grammar. It does not compete on `$PATH`. |
| Workspace mount namespace | 2 coherence | Do not document `epicenter run matter.*` as a Matter UX | Matter is not a workspace-backed mount today. Add this only if Matter later grows a real `defineMount` surface. |
| Product name | 3 taste | Keep `Matter` only with Epicenter context for public copy | The name fits frontmatter and the app's model, but it is too generic to stand alone in technical contexts. |
| Package name | 2 coherence | Keep `@epicenter/matter`; never publish unscoped `matter` | Scoped package name carries ownership and avoids npm namespace ambiguity. |

## Target Shape

The public surfaces should read like this:

```sh
epicenter matter open .
epicenter matter check .
```

The public surfaces should not read like this:

```sh
matter open .
matter check .
```

In product copy, prefer:

```txt
Matter by Epicenter
```

In technical docs, prefer:

```txt
the Matter app
apps/matter
@epicenter/matter
epicenter matter
```

Avoid phrases that imply `matter` is a shell command unless a code block explicitly shows `epicenter matter`.

Avoid `epicenter run matter.*` in Matter docs unless the doc is explicitly about a
future workspace mount. Today there is no Matter action graph behind the daemon,
so `run matter.*` would teach the wrong mental model.

## Implementation Notes

No code change is required by this decision today. The current package metadata already follows the rule:

- `packages/cli` publishes only `epicenter`.
- `apps/matter` is private and scoped as `@epicenter/matter`.
- The Tauri app display name is Matter, with identifier `so.epicenter.matter`.
- `apps/matter` has no `@epicenter/workspace` dependency and no mount action surface.

If a future change adds Matter commands to the CLI, add them under the existing `epicenter` binary:

```txt
packages/cli/src/commands/matter.ts
  command: "matter <subcommand>"

packages/cli/src/cli.ts
  .command(matterCommand)
```

Do not add this to any `package.json`:

```json
{
  "bin": {
    "matter": "./bin/matter.mjs"
  }
}
```

## Verification

Before shipping a CLI or release that mentions Matter, check:

- `packages/cli/package.json` has no `bin.matter`.
- No package in the repo publishes an unscoped `matter` package.
- Matter command docs use `epicenter matter ...`, not `matter ...`.
- Matter docs do not use `epicenter run matter.*` unless Matter has gained a real workspace mount.
- Product copy says `Matter by Epicenter` or otherwise keeps Epicenter visible near the name.
- `matter.json` and `matter.sqlite` remain described as folder-local files, not commands.

Useful searches:

```sh
rg -n '"matter"|matter ' package.json packages apps docs specs
rg -n 'bin.*matter|matter\s+(open|check|run|sync)' packages apps docs specs
rg -n 'defineMount|@epicenter/workspace|defineTable|defineMutation|defineQuery' apps/matter
```

## Rejected Alternatives

### Publish a standalone `matter` command

Rejected. It is short and pleasant, but it takes the riskiest namespace for the least gain. Users already have a plausible reason to install another `matter` command from the smart-home ecosystem.

### Rename the app immediately

Deferred. The name is crowded, but it still works as an app name when paired with Epicenter. Rename before a broad public launch only if search, trademark, or positioning research shows that `Matter by Epicenter` is still too ambiguous.

### Put everything under generic `epicenter open`

Deferred. `epicenter open matter .` may be useful later, but it does not replace a Matter command family if the app grows validation, projection, repair, or model-generation commands.

### Treat Matter as a daemon action namespace now

Rejected for the current app. `epicenter run <mount.action>` is for project-local
workspace mounts. Matter's current truth is the folder on disk, not a Yjs-backed
workspace opened by the Epicenter daemon. A Matter command should call shared
folder/model logic directly or launch the desktop app; it should not pretend a
Matter mount exists.

## Open Questions

1. Should the first public landing page use `Matter by Epicenter` as the primary mark, or `Epicenter Matter`?
2. Should `epicenter matter check .` stay a folder-readiness command, or should a separate model-only command exist later?
3. Should repo checks enforce the no-`bin.matter` rule, or is this spec enough until a Matter CLI exists?
4. If Matter later needs daemon integration, should it become a real workspace-backed app, or should the daemon expose folder protocols that are not Yjs workspaces?
