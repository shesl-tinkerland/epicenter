# Matter Check Output

**Date**: 2026-06-10
**Status**: Draft
**Owner**: Braden
**Relates to**: `20260604T120000-typed-markdown-grid-editor.md`, `20260604T223000-matter-field-palette-and-conformance.md`, `20260610T174336-matter-zennotes-folder-protocol.md`, `20260610T185221-matter-cli-namespace-decision.md`

## One Sentence

Add a headless Matter check surface that answers whether a Matter folder satisfies its `matter.json` contract by producing one canonical cell-finding report, rendered as readable grouped text by default and as stable JSON for agents and CI.

## How to read this spec

```txt
Read first:
  One Sentence
  Target Shape
  Command Boundary
  Asymmetric Wins
  Output Contract
  Implementation Plan
  Verification

Read if changing the architecture:
  Design Decisions
  Research Findings
  Rejected Alternatives
  JSON Report Shape

Deferred:
  epicenter matter promotion
  Matter core package extraction
  SARIF/JUnit/dbt-style artifacts
  Full matrix output
  Fix mode
```

## Overview

Matter already has the pure validation path: parse Markdown rows, parse `matter.json`, classify each modeled field as `OK`, `EMPTY`, `NEEDS_VALUE`, or `INVALID`, and keep unreadable files separate. The missing surface is a command that exposes that same truth outside the UI without opening the Tauri app.

The command should not become a second validator. It should read files from disk, call the existing core, project the result into a small `CheckReport`, print it, and exit with a meaningful status code.

## Confidence

These are the best patterns for v1 given the current product shape. They are not "best possible" in the abstract. Tools like ESLint, TypeScript, pytest, dbt, Ajv, and data quality frameworks converge on the same split:

```txt
human default      concise, grouped, fix-oriented
machine artifact   stable, explicit, versioned
exit code          small contract for automation
extra formats      added only when integrations demand them
```

Matter should copy that split, not their whole plugin/reporting ecosystems.

## Current State

`apps/matter/scripts/inspect.ts` is a dogfood script, not a stable command. It tries to read a folder and print a matrix, but it has drifted from the core row shape (`name` vs `fileName`).

Current pure core:

```txt
parse.ts         parse one Markdown file into frontmatter + body
model.ts         parse matter.json and recognize field schemas
conformance.ts   classify each row/field cell as OK, NEEDS_VALUE, INVALID
folder.ts        readFolder(entries, modelText) -> FolderRead
```

Current UI behavior:

```txt
modeled folder      show typed grid and per-cell states
missing model       show raw frontmatter view
junk model          show raw frontmatter view with diagnostic
unreadable file     route to "Can't read"
extras              show raw in row detail, never affect validity
```

The CLI should share the same core classification, but it should be stricter than the UI when no usable contract exists.

## Target Shape

```txt
bun run --cwd apps/matter check [folder]
```

The app-local command defaults to `.` when `[folder]` is omitted. It must not
default to the sample vault.

Later, if Matter commands are promoted into the public Epicenter CLI:

```txt
epicenter matter check <folder>
```

The command has exactly two output modes in v1:

```txt
default   readable text for a terminal
--json    CheckReport v1, no extra prose
```

No other flags in v1.

## Command Boundary

This spec builds the first headless Matter command. It does not turn Matter into
an Epicenter daemon mount.

Current Matter truth:

```txt
folder on disk
  -> matter.json
  -> top-level *.md files
  -> optional matter.sqlite projection
```

Current Matter non-truth:

```txt
Yjs workspace
defineTable schema
defineMount project entry
daemon action namespace
```

That means the implementation path is app-local first:

```txt
bun run --cwd apps/matter check [folder]
```

The public CLI promotion path, if it happens, is an Epicenter subcommand:

```txt
epicenter matter check <folder>
```

It is not:

```txt
epicenter run matter.check '{}'
```

`epicenter run <mount.action>` is for project-local workspace mounts. Matter
does not have that surface today. If it ever grows one, that should be a
separate architecture decision, not an accidental byproduct of adding a checker.

It also does not mean Matter protocol logic belongs in `packages/cli`.
`packages/cli` can own a future command head, but it must not own Markdown
parsing, `matter.json` recognition, conformance classification, or report
projection. The Matter UI is the primary consumer of those rules today; it
should never depend on a command-line package to classify rows.

## Mental Model

A mismatch is a cell finding.

```txt
file.md + field -> state
```

That one finding has both coordinates. The default output groups findings by file because that is how a person fixes the folder. The footer tallies findings by field because that is how a person sees whether the model or a whole column is wrong.

```txt
CheckReport.findings
  -> group by file for terminal detail
  -> group by field for footer and dashboards
```

Do not build separate row and column validators. Build one finding list and project it.

## Output Contract

### Passing folder

```txt
bun run --cwd apps/matter check drafts

9 ready (9 files)
```

Exit code: `0`.

### Failing folder

```txt
bun run --cwd apps/matter check drafts

carousel-2026-trends.md
  url              needs value

how-i-edit-videos.md
  duration         invalid: got "five", expected integer

legacy-import.md
  destinations     needs value
  publishDate      needs value
  duration         needs value
  url              needs value
  note: extra keys legacyId, mood, metadata

broken.md
  can't read: frontmatter is not valid YAML

By field:
  url              4 needs value
  duration         2 needs value, 1 invalid
  destinations     3 needs value
  publishDate      3 needs value

1 ready, 6 need attention, 2 unreadable (9 files)
```

Exit code: `1`.

### No usable contract

Missing `matter.json`, invalid JSON, a non-object `fields`, or any unrecognized field schema means the command cannot certify the folder.

```txt
bun run --cwd apps/matter check drafts

cannot check drafts: matter.json is missing
```

```txt
bun run --cwd apps/matter check drafts

cannot check drafts: field "status" has an unrecognized shape
```

Exit code: `2`.

This deliberately diverges from the UI. The UI may degrade to a raw view so the user can keep working. The checker must not silently pass a folder without a usable contract.

## Exit Codes

| Code | Meaning | Examples |
| --- | --- | --- |
| `0` | The folder is certified ready. | Every modeled cell is `OK` or `EMPTY`; no unreadable files. |
| `1` | The folder has content failures. | `NEEDS_VALUE`, `INVALID`, unreadable Markdown file. |
| `2` | The command cannot certify the folder. | Missing or junk `matter.json`, unrecognized field schema, folder path cannot be read. |

## JSON Report Shape

`--json` prints only JSON to stdout. It never serializes `FolderRead` directly because that would leak internal objects, functions, row bodies, and unstable shapes.

```ts
type CheckReport = {
  version: 1;
  folder: string;
  model: {
    fields: Array<{ name: string; kind: string; required: boolean }>;
  };
  summary: {
    files: number;
    ready: number;
    needsAttention: number;
    unreadable: number;
  };
  findings: Array<
    | {
        file: string;
        field: string;
        state: 'NEEDS_VALUE';
      }
    | {
        file: string;
        field: string;
        state: 'INVALID';
        actual: unknown;
        expected: string;
      }
  >;
  byField: Array<{
    field: string;
    ok: number;
    empty: number;
    needsValue: number;
    invalid: number;
  }>;
  unreadable: Array<{
    file: string;
    error: string;
  }>;
  extras: Array<{
    file: string;
    keys: string[];
  }>;
};
```

Fatal `2` cases should also emit JSON when `--json` is present:

```ts
type FatalCheckReport = {
  version: 1;
  folder: string;
  fatal: {
    code:
      | 'FOLDER_UNREADABLE'
      | 'MODEL_MISSING'
      | 'MODEL_INVALID'
      | 'MODEL_UNRECOGNIZED_FIELD';
    message: string;
    fields?: string[];
  };
};
```

## Message Vocabulary

Use the domain states already in code:

```txt
OK
EMPTY
NEEDS_VALUE
INVALID
```

Human text maps them this way:

```txt
OK             ready
EMPTY          ready
NEEDS_VALUE    needs value
INVALID        invalid
unreadable     can't read
```

`EMPTY` means an optional modeled field is absent or null. It is valid and should
not print as a finding in the default human output. It should still be counted in
JSON `byField` so field totals explain every row.

Do not introduce `warning`, `error`, `info`, `pass`, `fail`, or lowercase `empty` as new domain states. If a value blocks readiness, it is a finding. If it does not block readiness, it is a note or a JSON side field.

## Expected Values

`INVALID` needs a useful expected string, but v1 should not wait on full JSON Schema keyword-level errors.

Add a small helper beside the check projection:

```ts
describeExpected(field): string
```

Examples:

```txt
string
url
integer
number
boolean
one of draft, ready, published
array of strings
array containing one of linkedin, x, newsletter
JSON matching the field schema
```

Human output truncates actual values to a readable preview. JSON includes `actual` exactly as parsed from frontmatter, but never includes the Markdown body.

## Research Findings

| Tool | Pattern | Matter should borrow |
| --- | --- | --- |
| ESLint | Readable default formatter plus JSON formatters. Config/setup failures are not lint findings. | Human default plus JSON. Keep setup failures exit `2`. |
| TypeScript | `--noEmit` makes checking useful in CI without producing artifacts. Diagnostics are file-oriented. | Check the folder without opening UI or writing sidecars. |
| pytest | Default output is concise; verbosity expands detail; JUnit exists for integrations. | Start concise. Do not add CI artifact formats until someone asks. |
| dbt | Test results have artifacts and column-ish/data-quality semantics. | Include `byField` because Matter failures often cluster by column. |
| Ajv and JSON Schema validators | Machine-readable validation results matter as much as human errors. | Use a stable `CheckReport`, not internal object serialization. |
| Great Expectations style data validation | Data quality tools make column patterns visible. | Include a column tally, but keep row-level findings as the canonical facts. |

Key finding: mature tools do not make one output do everything. They have a readable default and a stable machine artifact. Specialized report formats come later.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Canonical grain | 2 coherence | Cell finding | Existing `Cell` already carries row and field coordinates. |
| Default grouping | 3 taste | Group by file, footer by field | File grouping is fix-oriented; field tally exposes model or column-wide failures. |
| Machine output | 2 coherence | `CheckReport` v1 | Agents need a stable contract; internal core types are not a wire format. |
| Missing model | 2 coherence | Exit `2` | A checker without a contract cannot certify anything. |
| Unrecognized model field | 2 coherence | Exit `2` | A typo in `matter.json` should not become a silent pass. |
| Extras | 2 coherence | Notes only, never failing | Existing invariant says extras never affect validity. |
| Flags | 3 taste | Only `--json` in v1 | One human output and one machine output are enough to prove the behavior. |
| Protocol owner | 2 coherence | Keep Matter protocol in `apps/matter/src/lib/core` for v1 | The Matter UI and app-local check script are one consumer family. Putting protocol rules in `packages/cli` would invert ownership. |
| Public CLI promotion | 2 coherence | `epicenter matter check`, not `epicenter run matter.check` | Matter is a folder protocol app today, not a daemon-mounted workspace action graph. |
| Protocol logic in `packages/cli` | 2 coherence | Never | The CLI is a thin published shell. Hosting parsing, conformance, or report projection there creates a second validator and couples model changes to CLI releases. |
| Extraction trigger | 2 coherence | Extract to `@epicenter/matter-core` when the first non-`apps/matter` consumer is written | A package boundary should be earned by a second real consumer, not by the possibility of one. |
| Formatter ecosystem | Deferred | Defer | Add only after a real integration needs it. |

## Asymmetric Wins

### Refuse formatter plugins in v1

Product sentence:

```txt
Matter can check a folder headlessly.
```

Candidate refusal:

```txt
--format stylish|json|junit|sarif|compact
```

Code family it deletes:

```txt
formatter registry
formatter option parser
format-specific tests
format-specific docs
format-specific stability promises
```

User loss:

```txt
No direct GitHub code scanning, JUnit, or custom CI reporter on day one.
```

Decision:

```txt
Refuse it. `--json` is enough for agents and CI wrappers. Add a second format only when a real consumer exists.
```

### Refuse full matrix output in v1

Product sentence:

```txt
Matter check tells you what blocks readiness.
```

Candidate refusal:

```txt
--all or inspect-style full row/column matrix
```

Code family it deletes:

```txt
table layout
terminal width handling
OK-cell rendering
large-folder pagination decisions
second human formatter
```

User loss:

```txt
The terminal does not show every passing cell.
```

Decision:

```txt
Refuse it for v1. The UI is the matrix. The CLI is the checker.
```

### Refuse `--strict`

Product sentence:

```txt
Matter check has one readiness policy.
```

Candidate refusal:

```txt
--strict
```

Code family it deletes:

```txt
dual policy matrix
strict vs non-strict docs
strict-specific exit-code tests
arguments about extras vs unmodeled fields
```

User loss:

```txt
Users cannot choose a softer or stricter policy at runtime.
```

Decision:

```txt
Refuse it. Missing/junk/unrecognized model shapes are exit 2. Extras remain notes. That gives one policy.
```

### Refuse fix mode

Product sentence:

```txt
Matter check reports readiness.
```

Candidate refusal:

```txt
bun run --cwd apps/matter check --fix
```

Code family it deletes:

```txt
write serialization
read-modify-write conflicts
partial repair semantics
YAML rewrite policy in a headless path
dry-run mode
undo story
```

User loss:

```txt
The command does not repair files by itself.
```

Decision:

```txt
Refuse it. Writes belong to the UI, agents, or a future explicit command with its own spec.
```

### Refuse SQLite and WHERE integration

Product sentence:

```txt
Matter check validates files against the model.
```

Candidate refusal:

```txt
bun run --cwd apps/matter check --where "status = 'ready'"
```

Code family it deletes:

```txt
mirror freshness dependency
SQL errors in validation path
filter semantics
rows missing from mirror due model failures
```

User loss:

```txt
Users cannot validate only a SQL-filtered slice in v1.
```

Decision:

```txt
Refuse it. The mirror is a query side channel, and WHERE-over-mirror is unsound
for validation because the mirror is not the source of every failing row. The
checker reads source files.
```

Future subset checking should be file-based, not SQL-based. If dogfood shows
agents repeatedly re-checking a whole large folder after editing two files,
consider `bun run --cwd apps/matter check folder/a.md folder/b.md` as a
separate small addition. If promoted later, the public spelling is
`epicenter matter check folder/a.md folder/b.md`.

### Refuse protocol extraction now

Product sentence:

```txt
Matter has one app-local headless checker.
```

Candidate refusal:

```txt
@epicenter/matter-core
```

Code family it deletes:

```txt
package boundary
exports contract
versioning
license discussion
second-package tests
```

User loss:

```txt
Other apps cannot import the checker core as a package yet.
```

Decision:

```txt
Refuse it until there is a second real consumer. Keep the command app-local.
```

Still keep the pure core extractable. Put `FolderRead -> CheckReport` in
`src/lib/core/check-report.ts` from day one, with no disk I/O and no CLI argument
parsing. Keep parsing, model recognition, conformance, folder reading,
reporting, and formatting under `src/lib/core` so extraction can be a move, not
a rewrite.

Promotion to `epicenter matter check` requires extraction first. `packages/cli`
is a published package and `apps/matter` is private, so the CLI can neither
import the app nor reimplement its validation. When promotion happens,
`packages/cli` is the second consumer that triggers extraction. The CLI command
is a thin adapter over the extracted package.

Trigger:

```txt
Extract when the first non-apps/matter import is written, not before.
```

If extracted, the package name must not contain `protocol`; see the external
Matter protocol collision in `20260610T185221-matter-cli-namespace-decision.md`.

### Refuse putting protocol logic in packages/cli

Product sentence:

```txt
Matter owns the folder protocol; command heads call it.
```

Candidate refusal:

```txt
packages/cli/src/commands/matter.ts owns parse, model, conformance, or report projection
```

Code family it deletes:

```txt
UI importing CLI
duplicate Matter core beside the UI core
CLI dependency growth from app protocol concerns
yargs/auth/workspace concepts leaking into row classification
drift between UI readiness and headless readiness
```

User loss:

```txt
No `epicenter matter check` on day one.
```

Decision:

```txt
Refuse it. Implement app-local first. A future `epicenter matter check` command
may live in `packages/cli`, but only after the protocol has an importable package
that both the UI family and CLI can call.
```

## Architecture

```txt
scripts/check.ts
  -> read top-level *.md and matter.json from disk
  -> readFolder(entries, modelText)
  -> buildCheckReport / buildFatalCheckReport (src/lib/core/check-report.ts)
  -> format text or JSON
  -> set exit code
```

Ownership:

| Concern | Owner |
| --- | --- |
| Matter folder protocol for v1 | `apps/matter/src/lib/core` |
| Markdown parsing | `parse.ts` |
| Model parsing and field recognition | `model.ts` + `@epicenter/field` |
| Cell states | `conformance.ts` |
| Folder read shape | `folder.ts` |
| Disk listing for headless command | `scripts/check.ts` |
| Report projection | `src/lib/core/check-report.ts` |
| Human formatting | `src/lib/core/check-format.ts` (pure `CheckReport -> string`) |
| JSON wire shape | `CheckReport` type |
| Future public command head | `packages/cli/src/commands/matter.ts` after protocol extraction |

The report projection starts in `src/lib/core/check-report.ts`, and human text
formatting starts in `src/lib/core/check-format.ts`. The command head stays the
owner of disk I/O, argument parsing, stdout, stderr, and exit codes. Do not
extract a package yet, and do not move protocol logic into `packages/cli`.

## Implementation Plan

### Phase 1: replace inspect with check

```txt
[ ] Fix the `name` vs `fileName` drift.
[ ] Rename or replace `scripts/inspect.ts` with `scripts/check.ts`.
[ ] Add `check` script to `apps/matter/package.json`.
[ ] Keep the command app-local: `bun run --cwd apps/matter check [folder]`.
[ ] Do not add or document `epicenter run matter.*`.
[ ] Do not add Matter protocol logic to `packages/cli`.
```

### Phase 2: report projection

```txt
[ ] Build `CheckReport` from `FolderRead`.
[ ] Build `FatalCheckReport` for exit-2 cases.
[ ] Add `byField` tally.
[ ] Add `extras` list.
[ ] Add `describeExpected(field)`.
[ ] Keep the projection pure: no filesystem, no process exit, no CLI args.
```

### Phase 3: formatting

```txt
[ ] Default text prints only findings, notes, by-field tally, and summary.
[ ] `--json` prints only JSON.
[ ] No color required in v1.
[ ] Human output truncates long actual values.
```

### Phase 4: tests

```txt
[ ] Spawn test for exit 0.
[ ] Spawn test for exit 1.
[ ] Spawn test for exit 2 missing model.
[ ] Spawn test for exit 2 junk model.
[ ] Snapshot default text for a mixed fixture.
[ ] Snapshot JSON for the same fixture.
[ ] Test output is deterministic across two runs.
```

## Verification

Fixture folder:

```txt
apps/matter/fixtures/matter-check/
  matter.json
  ready.md
  optional-empty.md
  missing-required.md
  invalid-status.md
  invalid-number.md
  extras.md
  broken-yaml.md
  conflict-markers.md
```

Acceptance:

```txt
[ ] Passing fixture exits 0 and prints one summary line.
[ ] Mixed fixture exits 1 and groups findings by file.
[ ] Mixed fixture includes a by-field tally.
[ ] Broken YAML and conflict markers are unreadable failures.
[ ] Extras are reported as notes and never affect exit code.
[ ] Optional empty cells are ready, do not print as findings, and increment `byField.empty` in JSON.
[ ] Missing matter.json exits 2.
[ ] Junk matter.json exits 2.
[ ] Unrecognized field schema exits 2.
[ ] `--json` output contains no Markdown body text.
[ ] `--json` output contains `version: 1`.
[ ] Docs mention `epicenter matter check` only as future promotion.
[ ] Docs do not present `epicenter run matter.*` as a Matter command.
```

## Rejected Alternatives

### Keep `inspect` beside `check`

Reject. Two headless renderers over the same core will drift. The current `inspect.ts` already demonstrates that risk.

### Default to a spreadsheet matrix

Reject for v1. The UI is the right place for a matrix. The CLI should print what blocks readiness.

### Warnings and severities

Reject. Matter already has domain states. `NEEDS_VALUE` and `INVALID` both block readiness. Extras do not. Unreadable files are failures. Missing or unusable model is fatal.

### Full JSON Schema error output

Defer. Better invalid messages are useful, but v1 can derive expected strings from field kind and schema. Full keyword-level validator errors can be added later if `@epicenter/field` exposes them cleanly.

### CI-specific formats

Defer. `--json` is the integration contract. Build SARIF, JUnit, or dbt-style artifacts only after a real consuming workflow exists.

### Expose the checker through `epicenter run matter.check`

Reject. That command shape would imply a Matter `defineMount` and daemon action
namespace. The current app reads folders directly and has no Yjs workspace
runtime. Use an app-local script first, then promote to `epicenter matter check`
if the package boundary earns it.

### Put Matter protocol inside packages/cli

Reject. `packages/cli` is a command head, not the domain owner. The Matter UI
must not depend on the CLI package for row classification. If public CLI
promotion becomes necessary, extract `@epicenter/matter-core` first, then let
`packages/cli` call that package.

## Open Questions

1. Should a missing `matter.json` be exit 2 forever, or should a future app-local `check --allow-raw` exist for inventory-only workflows?
2. Should `actual` in JSON be capped for very large invalid frontmatter values, or should JSON stay exact and leave presentation to consumers?
3. Should color be added to the human formatter after v1, or is plain text enough?
4. When `epicenter matter check` is promoted, extraction happens by moving `src/lib/core` as a unit: parse, model, conformance, folder, check-report, and check-format. Open: does ZenNotes consume the same package, or only the folder protocol spec?

## Tentative Decisions To Revisit After Dogfood

```txt
No --all.
No --quiet.
No --strict.
No --fix.
No formatter registry.
No package extraction.
No protocol logic in packages/cli.
No SQLite dependency.
No body text in JSON.
```

If any one of these becomes painful in real use, add that one feature with a fixture and a consumer. Do not add the whole family.
