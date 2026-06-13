# Root README Public Front Door

**Date**: 2026-06-10
**Status**: Implemented
**Owner**: Braden
**Consults**:

- Claude consult `claude-90354a0b` (design mode, read-only, 2026-06-10, cost signal `$0.504459`)
- Claude consult `claude-1bfacb98` (design mode, read-only, 2026-06-10, cost signal `$0.583849`)
- Claude consult `claude-27ee8dbb` (design mode, read-only, 2026-06-10, cost signal `$0.741374`)
- Claude consult `claude-95ca4a8f` (docs mode, read-only, 2026-06-10, cost signal `$1.157114`)
- Claude consult `claude-0fae1088` (docs mode, read-only, 2026-06-10, cost signal `$1.239014`)
- Claude consult `claude-7dce7b42` (docs mode, read-only, 2026-06-10, cost signal `$1.882344`)
- Prior newcomer subagents: public visitor, local-first developer, privacy-minded user, final public-read verifier
- External comparison: [ZenNotes/zennotes](https://github.com/ZenNotes/zennotes)

## One Sentence

The root README owns the public front door: it sells the future workspace first, then immediately grounds that promise in two proof paths, install Whispering today or build with `@epicenter/workspace`.

## How to Read This Spec

```txt
Read first:
  One Sentence
  Greenfield Product Sentence
  Resolved Framing
  Target README Shape
  Decisions
  Implementation Plan

Read if revisiting the strategy:
  Claude Consult Summary
  ZenNotes Comparison
  Rejected Alternatives
  Current README Findings
```

## Overview

The root README currently tells the truth, but it still carries too much internal anxiety. This spec records the greenfield shape for a public 4.7k-star repo: future-facing workspace promise first, current proof paths second, then the ownership model, status, trust boundaries, repo map, and contribution path.

## Greenfield Product Sentence

```txt
The root README sells local-first apps for a workspace you own.
It opens with the capture -> projection -> curation loop, then routes newcomers into two proof paths:
install Whispering today, or build with the local-first workspace toolkit.
Everything else explains the ownership model, status, trust boundaries, repo shape, and contribution path.
```

This sentence is the clean-break test. If a README section does not help one of those jobs, it should move to a per-surface README, `docs/`, `specs/`, or `CONTRIBUTING.md`.

## Resolved Framing

Hero copy should point where the project is going:

```txt
Local-first apps. One workspace you own.

Capture in purpose-built apps.
Read the generated Markdown. Query the SQLite mirror.
Curate what matters into Markdown folders you can grep, version, and keep forever.
Sync between devices when you want.
```

Directly beneath the hero, ground it in the present:

```txt
Whispering is downloadable today. A workspace-native refresh of Whispering is in
progress, and the shared workspace for tabs, notes, drafts, and publishing is
being built in public on @epicenter/workspace.
```

Use `workspace` as the public noun for now. Defer `vault` until the model section, if it is used at all, and only as the local folder shape rather than a competing hero noun.

Keep encryption out of the hero. It is true that signed-in workspace sync sends encrypted CRDT values over Yjs, but the hosted model is server-managed encryption, not user-held zero-knowledge. Trust copy should be precise:

```txt
Workspace sync sends encrypted CRDT values over Yjs. On hosted Epicenter,
encryption keys are server-managed; self-hosting moves the key boundary to
infrastructure you control.
```

One-sentence test:

```txt
Epicenter lets purpose-built local-first apps keep live state in Yjs, expose it as Markdown and SQLite in a workspace you own, and sync encrypted updates across devices when you choose.
```

## Current State

The current README is much better than the original mature-suite framing. It now says Whispering is the installable product today, explains Markdown, SQLite, and Yjs, and adds trust boundaries.

The remaining weakness is shape. The README still behaves like a thesis document with an install command attached:

```txt
hero
  -> installable product caveat
  -> toolkit example
  -> why / model / trust
  -> status caveats
  -> repo inventory
  -> agent skills
  -> architecture
  -> development
  -> design notes
```

This creates problems:

1. **Two doors share one corridor**: Whispering users and toolkit adopters both enter through `What You Can Use Today`.
2. **Status language repeats**: The README uses several variants of "not a finished product," "not a marketplace," "not a launcher," and "not the current lineup."
3. **Internal material leaks upward**: `Agent Skills`, a long design-notes table, recovery commands, and CLI auth details compete with the public front door.
4. **The repo map names too much**: Naming every prototype makes the first page feel like a history index instead of a product map.
5. **The hero hedges early**: The top line says what is real and what is future in the same breath, which is honest but slightly effortful.

## Target README Shape

Greenfield order:

```txt
Hero
  one future-facing workspace promise:
    Local-first apps. One workspace you own.
    Capture in purpose-built apps.
    Read the generated Markdown. Query the SQLite mirror.
    Curate what matters into Markdown folders you can grep, version, and keep forever.
    Sync between devices when you want.
  one status line:
    Whispering is downloadable today; a workspace-native refresh of Whispering is in progress; the shared workspace for tabs, notes, drafts, and publishing is being built in public.

Install Whispering
  brew command
  one sentence for what it does
  platform release link
  trust-model link

Build With The Toolkit
  @epicenter/workspace one-paragraph promise
  one code block
  package README link

How It Works
  Matter = WIP front for user-owned Markdown folders; edits ordinary folders directly
  apps/<name>/ = generated app projections; read, grep, quote, copy
  .epicenter/ = machine state; ignore
  journal/, ideas/, publish/ = your Markdown; edit, commit, curate, publish
  Yjs = live app state
  SQLite = query mirror
  CLI actions = validated writes into app data

Status
  one confident paragraph
  no scattered disclaimers
  future promise first, current proof paths immediately after

Trust Boundaries
  keep the table
  keep concrete provider paths
  include the encrypted CRDT sync sentence, but avoid zero-knowledge shorthand

Repo Map
  Whispering
  Matter
  @epicenter/workspace toolkit packages
  API and self-host deployables
  one unnamed line for prototypes and research

Development
  clone, install, default scripts
  link out for API setup, CLI auth, cleanup, and contribution details

Community And License
  concise links
```

## Claude Consult Summary

Claude's strongest sentence:

> The current Epicenter README is a thesis document with an install command attached; it should be a two-door front door: "install Whispering in 30 seconds" and "adopt `@epicenter/workspace` in one code block," with the vision, architecture, and repo inventory demoted to one short section each plus links.

Accepted:

- The root README should split Whispering and `@epicenter/workspace` into separate top-level doors.
- Status should live mostly in one section, not as repeated "not X" disclaimers.
- The repo map should stop naming every older prototype on the public front page.
- The design-notes table is too internal for the root README.
- ZenNotes' "install before ideology" ordering applies directly.

Modified:

- Claude suggests cutting the design notes table entirely from the root. The better version is to replace it with a single link to `specs/README.md` plus 2 or 3 current strategy links if needed.
- Claude suggests shrinking packages to the MIT toolkit plus `@epicenter/server`. Keep `@epicenter/svelte` only if the README still claims a Svelte app composition story; otherwise link to package docs.
- Claude initially framed the hero around the shipped product plus toolkit. That was accurate for first-minute routing, but it is superseded by the decision to make the future workspace promise the hero and keep Whispering as proof.

Rejected:

- Do not copy ZenNotes' exhaustive install and ops depth. Epicenter spans a desktop app, toolkit, hosted API, self-host deployable, and experiments; the root README must link out earlier.
- Do not remove the broader vision. Epicenter is not only Whispering, and the README should preserve the capture-to-context-to-publish direction.
- Do not hide the work-in-public status. The clean break is not "market harder"; it is "place honesty where it orients instead of where it interrupts."

### Later consult correction

The later Claude consults correctly flagged two risks, but the final decision is to aim the hero at the future system.

Accepted:

- The first screen should sell the durable workspace promise, not the current app lineup.
- Whispering should be the first proof path, not the thesis.
- `workspace` is the public noun for now; do not use `vault` in the hero.
- Sync belongs in the hero as optional device sync, but encryption belongs in Trust Boundaries.
- The README must be explicit that the broader shared workspace is being built in public.

Modified:

- Claude recommended "folder you own" to avoid Obsidian baggage. Use "workspace you own" in the hero because it matches the project vocabulary, and explain the folder shape in How It Works.
- Claude warned that the full capture -> projection -> curation loop is not fully shipped. Keep the loop as the future promise, then put the status line directly under it.

Rejected:

- Do not make the README thesis today's shipped-product-plus-toolkit proof. That is today's proof, not the north star.
- Do not put "encrypted Yjs" in the hero. It is technically interesting but too easy to misread as zero-knowledge.
- Do not make `@epicenter/workspace` the hero noun. The toolkit is how the promise is built, not what a public visitor should remember.

## ZenNotes Comparison

ZenNotes works as a public README because it has one centered product promise:

```txt
keyboard-first Markdown notes app
  -> install
  -> what it can do
  -> product modes
  -> data ownership
  -> development
```

Borrow:

- Put the install path immediately after the hero.
- Say what works in present tense before explaining implementation.
- Give status as a maturity map, not a warning label.
- Use a small repo tree or compressed map rather than full inventory.

Refuse:

- Do not copy the full feature matrix and ops detail into the root README.
- Do not assume one product center when Epicenter currently has two public entry points.
- Do not bury the why. Epicenter's substrate model is its differentiator and should stay visible.

## Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Public entry shape | 2 design coherence | Future workspace promise, then two proof paths | The app lineup will change; the durable promise is local-first apps feeding a workspace the user owns. |
| Hero status | 3 taste under constraints | One honest status sentence, no defensive framing | A public README should orient before it cautions. |
| Vision placement | 2 design coherence | Lead with the vision, ground it immediately | The README should point where the puck is going while making today's proof paths obvious. |
| Trust language | 1 evidence | Concrete "what leaves your device" table plus encrypted CRDT sync wording | Avoids vague privacy claims and maps well to the hosted vs self-hosted key boundary. |
| Public noun | 2 design coherence | `workspace`, not `vault` | `workspace` is project vocabulary; `vault` is useful later but carries Obsidian baggage and internal package ambiguity. |
| Encryption in hero | 2 design coherence | Keep out of hero | The hosted model encrypts CRDT values, but it is server-managed encryption rather than user-held zero-knowledge. |
| Repo map | 2 design coherence | Name active surfaces; collapse older prototypes | Prevents the public front page from reading like internal archaeology. |
| Agent Skills | 2 design coherence | Move lower or compress under development | Useful for repo agents, not a newcomer decision. |
| Design Notes | 2 design coherence | Replace table with a short link set | Specs are valuable, but the root README should not be the spec index. |
| Troubleshooting | 3 taste under constraints | Move cleanup and CLI auth details lower or out | Important for contributors, not first-screen material. |

## Recommended Status Wording

Use this as the single source of status truth:

```md
## Status

Whispering is the first shipped app: install it today on macOS, Windows, or Linux. A larger workspace-native refresh of Whispering is in progress, and current installs will receive it through the normal release path.
The shared workspace for tabs, notes, drafts, and publishing is being built in public around `@epicenter/workspace`. Matter is the current WIP front for the folders-you-own side: it edits ordinary Markdown folders and keeps `matter.sqlite` as a query mirror.
Other app folders are public research and prototypes.
```

This wording avoids "but," "not every," "not a," and apology cadence.

## Implementation Plan

- [x] Update `docs/positioning.md` so the canonical one-liner matches the resolved front-door framing.
- [x] Rewrite the root README hero around the future workspace promise and one immediate status line.
- [x] Split `What You Can Use Today` into `Install Whispering` and `Build With The Toolkit`.
- [x] Replace `Why Epicenter Exists` / `How The Model Works` with `How It Works`, centered on ownership: app projections, user-owned folders, Yjs, SQLite, and CLI actions.
- [x] Keep the trust-boundaries table, with no absolute privacy claims, and add the encrypted CRDT sync sentence there.
- [x] Replace repeated disclaimers with the single status paragraph above.
- [x] Collapse older prototype names into one unnamed repo-map line.
- [x] Move `Agent Skills` below `Development` or compress it to one line in the repo map.
  > Implemented by removing the Agent Skills section from the public front door; skills remain discoverable from repo docs and package docs.
- [x] Replace `Design Notes` table with links to `docs/README.md`, `specs/README.md`, and at most 2 current strategy specs.
- [x] Move cleanup, `bun nuke`, and CLI local auth details to contributor docs if they are not already there.
  > Implemented by removing those details from the root README; the API and CLI READMEs keep the focused operational setup.
- [x] Run a Claude review consult on the README diff only, asking for overpromises, unclear ownership, and privacy/security wording risks.
  > Claude consult `claude-6c81b1d3` found no clearly false statement. It flagged license wording, present-tense workspace model, hosted key-boundary wording, and the hosted sync table row. The license wording checked out against root `LICENSE` and package manifests; the other findings were patched.
- [x] Re-run doc path checks and punctuation scans.

## Execution Plan

Execute in three passes:

```txt
1. Alignment pass
   docs/positioning.md
   specs/20260610T173324-root-readme-public-front-door.md

2. README rewrite
   README.md only
   Keep the hero short, install path visible, and How It Works concrete.

3. Grill and verify
   Claude consult on the README diff only.
   Local checks: doc paths, diff whitespace, no em/en dashes, no banned vague claims.
```

Do not run another broad Claude strategy consult before editing. The strategic branch is resolved enough to implement. Use Claude next as a bounded reviewer of the concrete diff.

## Verification

After editing the README:

```bash
bun run check:doc-paths
git diff --check -- README.md
rg -n -P '\\x{2014}|\\x{2013}' README.md || true
rg -n '[^\x00-\x7F]' README.md || true
rg -n 'AI-native|agentic|revolutionary|ecosystem|all apps|each app shares|Every tool|server never sees|never sees your content|all 12|polished suite|large overhaul|workshop|private worklog|internal archaeology' README.md || true
```

Also do a human first-minute read:

```txt
Can I install something?
Can I build with something?
Do I understand what is real today?
Do I understand what is being built in public?
Did the README make me feel invited rather than warned?
```

## Open Questions

1. Should the root README include a screenshot or GIF of Whispering near the install command?
2. Should `@epicenter/workspace` have a published package install command in the root README, or only a source link until package-level docs are refreshed?
3. Should `specs/README.md` become the canonical public index for design notes before the root README links to it more prominently?
4. Should the Whispering README move install above the personal story in a separate follow-up?
5. Should `vault` become a public noun later, or stay an internal/spec noun while the README uses `workspace` and `folders you own`?

## Review

**Completed**: 2026-06-10

### What Landed

The root README now leads with the future-facing workspace promise, then grounds it in the shipped Whispering app and the `@epicenter/workspace` toolkit. `docs/positioning.md` now uses the same north star, so future public copy has one source of truth instead of competing one-liners.

The README's model section now names the ownership boundary directly:

```txt
apps/<name>/  generated app projections
.epicenter/   machine state
journal/      user-owned Markdown
Yjs           live app state
SQLite        query mirror
CLI actions   validated writes into app data
```

### Review Notes

- Claude review `claude-6c81b1d3` confirmed the rewrite removed the old risky claims around `server never sees your content`, E2E wording, and "all apps."
- Claude grill `claude-95ca4a8f` judged the rewrite a net improvement, but flagged that it under-proved the Markdown and SQLite claim, flattened the developer hook, and lost the old README's "grep it" texture.
- The post-grill pass restored a punchier headline, a safe "grep, version, keep forever" line, concrete Markdown and SQLite examples, platform badges, the local-first sync problem statement, and a temporary Whispering workspace-native refresh hint.
- Claude grill `claude-0fae1088` flagged the main remaining inaccuracy: the README blurred Matter with generated app projections. The correction now says Matter is the WIP front for user-owned Markdown folders, while `apps/<name>/` remains generated app output.
- The second grill also caught stale positioning package copy for `@epicenter/vault`; the public package table now matches real front-door packages.
- Claude grill `claude-7dce7b42` recommended keeping the headline, making the Whispering refresh subject explicit, qualifying signed-in encrypted sync, and aligning CLI/package docs with the actual `list`, `run`, `run --peer`, `peers`, and daemon lifecycle commands.
- The package-doc alignment pass updated `@epicenter/workspace` to state the app-owned Yjs and read-only materializer boundary, updated CLI examples from `~/vault` to `~/workspace`, and aligned public package descriptions.
- The final trust wording explicitly says hosted keys are server-managed and links to `docs/encryption.md`.
- The status and How It Works sections both say the shared workspace is being built in public, so the future promise is not presented as fully shipped.

### Verification

```bash
bun run check:doc-paths
git diff --check -- README.md docs/positioning.md specs/20260610T173324-root-readme-public-front-door.md
rg -n -P '\x{2014}|\x{2013}' README.md docs/positioning.md specs/20260610T173324-root-readme-public-front-door.md || true
```

## Non-goals

- Do not rewrite Whispering's README in this spec.
- Do not hide that the broader workspace is active development.
- Do not present Epicenter as a finished suite of apps.
- Do not make the root README a full monorepo operations manual.
- Do not preserve current section order for compatibility. README section order is not a user contract.
