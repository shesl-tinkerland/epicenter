# Vocab answerer collapse: rename, browser-never-answers, hosted worker

Status: Draft. Date: 2026-06-20.

> **Repointed 2026-06-20 by [ADR-0043](../docs/adr/0043-an-agent-answers-where-its-capability-lives.md).**
> A use-case pass killed the hosted-worker premise: an agent answers where its
> capability lives. Vocab is capability-free, so the **client answers** (a
> client-side chat over the metered SSE stream); there is **no hosted managed
> worker**. **Wave 3 is dropped**, **Wave 4 is rewritten** to the client-side
> shape, and the agentic tool loop moves to its real consumer, Local Books
> (`20260620T180000-local-books-agent-over-sql.md`). The sections below are
> updated to match; Waves 1 and 2 already merged unchanged.

The durable decisions live in ADRs; this spec is the dependency-ordered wave plan.
Delete this spec when the waves land (the ADRs are the lasting record).

## Decisions (the lasting record is the ADRs)

- **ADR-0043** (supersedes ADR-0041) — an agent answers where its capability
  lives. A capability-free agent (Vocab) answers **in the client**; a local-data
  agent (Local Books) answers on the **daemon** where the data is. Epicenter runs
  **no per-user answering worker**: it is the blind box (relay + anchor) plus a
  metered inference stream. The conversation substrate (table row to child doc to
  parts) and the shared answer core stay; only the answer's origin differs.
- **ADR-0044** — tool approval is a per-conversation policy (`auto` / `ask` /
  `deny`), shipped as read-only / ask / auto, with a classifier deferred. Drives
  ADR-0042's doc-mediated approval. Vocab has no tools and does not use it.
- **ADR-0042** — the agent loop is the worker's, over the doc-as-message-array;
  durable doc-mediated approval. Un-deferred by **Local Books**, not Vocab.
- **ADR-0033 / ADR-0025 / ADR-0036 / ADR-0030** unchanged: the metered stream,
  the conversation child doc, the parts body, and the immutable agent bundle.

## End state for Vocab

- One app: a single Chinese vocab assistant. One model (`VOCAB_MODEL`), one
  system prompt, `tools: []`.
- Two agents in the catalog, distinguished by where the answer is produced:
  - **Client** (the capability-free default): the browser runs the shared answer
    core fed by the metered `/api/ai/chat` SSE stream, sinking parts into the
    conversation child doc. No hosted worker.
  - **Home daemon** (`vocab-home`, the user's own box): same loop, different host.
- The browser writes user turns, renders the synced doc, **and answers the client
  agent** (a capability-free agent answers in the client, ADR-0043).
- Close the browser mid-answer on the **client** agent → the answer stops; for a
  one-shot vocab lookup this is a non-goal (re-ask costs nothing). The daemon agent
  keeps writing because its worker is its own always-on box.

## Wave plan (each is one standalone, reviewable PR, in order)

| # | Wave | Depends on | Net |
|---|---|---|---|
| 1 | Rename zhongwen → vocab (incl. pre-release data ids) | — | **merged**; mechanical, no behavior change |
| 2 | Daemon ships live (`vocab-home`) | 1 | **merged**; proves worker-answers-over-sync on the user's box |
| 3 | ~~Hosted managed worker (on-demand DO)~~ | — | **DROPPED by ADR-0043** (phantom cell; not built) |
| 4 | Vocab client answers via metered SSE; drop the owner fork | 1, 2 | client-side chat over `/api/ai/chat`; the collapse |
| 5 | Agentic loop + doc approval | a tool consumer | **moved to Local Books**, not Vocab; ADR-0042 / 0044 hold the design |

Rename was first so nothing rebased over it. Wave 4 no longer waits on a hosted
worker (there is none): the client is the capability-free agent's answerer.

## PR / branch disposition

- **#2127** (owner ⊥ engine): **MERGED into main** (2026-06-20). Its `this-device`
  rename, owner fork, and `epicenterMeteredEngine` / `@epicenter/vocab/engine` subpath
  are now in main. Wave 4 deletes the owner fork + browser engine walk from main;
  the engine code wave 3 needs is lifted from main, not cherry-picked from a PR.
- **#2128** (presence slice 1): **parked.** Presence decorates liveness, never
  gates binding (the doc is a durable mailbox). Revisit as a fast-follow after
  wave 2, framed as the dead-mailbox warning ("you bound to your home daemon but
  nothing is home"). Do not merge it into this stack.
- `specs/zhongwen-conversation-deletion-refusal.md` — unrelated (deletion reclaim,
  terminal "Refused" status). Pre-existing hygiene smell; handle in a separate
  pass (convert to an ADR or delete). Wave 1 should rename its "zhongwen" mentions
  or delete it; it is not load-bearing here.

---

## Wave 1 — Rename zhongwen → vocab

**Goal.** A pure rename. `@epicenter/zhongwen` → `@epicenter/vocab` (package name,
directory `apps/zhongwen` → `apps/vocab`, every import, `ZHONGWEN_*` constants →
`VOCAB_*`, UI "Zhongwen" → "Vocab"). Because this is **pre-release**, also clean-
break the two data identities: workspace id `epicenter-zhongwen` → `epicenter-vocab`
and agent id `zhongwen-home` → `vocab-home`. The bilingual Chinese system prompt
and `gemini-3.5-flash` model are unchanged.

**Scope / files.**
- `apps/zhongwen/` → `apps/vocab/`: `package.json` (`name`), `zhongwen.ts`
  (`zhongwenWorkspace` id, `ZHONGWEN_*`, `THIS_DEVICE_AGENT_ID`, catalog),
  `mount.ts`, `epicenter-engine.ts`, `epicenter.config.ts`, `zhongwen.browser.ts`,
  `wrangler.jsonc` (`name`, the `zhongwen.epicenter.so` route → `vocab.epicenter.so`),
  `src/lib/session.ts`, `src/routes/.../ConversationView.svelte`,
  `ZhongwenSidebar.svelte` → `VocabSidebar.svelte`, the `@epicenter/zhongwen/engine`
  subpath export.
- Repo-wide consumers of `@epicenter/zhongwen` (grep the monorepo).
- `agents.test.ts` and any test asserting ids.

**Steps.**
1. `git mv apps/zhongwen apps/vocab`; rename files; update `package.json` name +
   exports map.
2. Find/replace `zhongwen` → `vocab`, `Zhongwen` → `Vocab`, `ZHONGWEN_` →
   `VOCAB_`, `epicenter-zhongwen` → `epicenter-vocab`, `zhongwen-home` →
   `vocab-home`, `THIS_DEVICE_AGENT_ID` stays (`this-device` is already neutral —
   though see wave 4, where it dissolves).
3. Update the custom domain in `wrangler.jsonc`.
4. Wipe dev rooms (manual: clear local IndexedDB + admin-wipe the DO room) so the
   new `epicenter-vocab` room starts clean.
5. Typecheck the workspace, run `apps/vocab` tests, biome.

**Acceptance.** `bun run` typecheck clean repo-wide; vocab tests green; no
remaining `zhongwen` string outside historical docs; app boots against the
`epicenter-vocab` room.

**Handoff prompt.**
> Rename the `@epicenter/zhongwen` app to `@epicenter/vocab` in the worktree
> `/Users/braden/Code/.worktrees/epicenter-row-childdocs`. This is pre-release, so
> clean-break everything including data identities: `git mv apps/zhongwen apps/vocab`,
> rename `@epicenter/zhongwen` → `@epicenter/vocab` (package name + the `/engine`
> subpath), `ZHONGWEN_*` → `VOCAB_*`, the workspace id `epicenter-zhongwen` →
> `epicenter-vocab`, the agent id `zhongwen-home` → `vocab-home`, the
> `zhongwen.epicenter.so` route → `vocab.epicenter.so`, and all UI "Zhongwen" →
> "Vocab" (rename `ZhongwenSidebar.svelte` → `VocabSidebar.svelte`). Keep the
> Chinese system prompt and `gemini-3.5-flash` model exactly. Grep the whole
> monorepo for `zhongwen`/`Zhongwen` and update every consumer. Do NOT change any
> answering behavior — this is a pure rename. Read the writing-voice skill for UI
> strings. Typecheck the repo, run the vocab app tests, run biome. One commit (or
> a small handful of mechanical commits). This is wave 1 of
> `specs/20260620T000000-vocab-answerer-collapse.md`.

---

## Wave 2 — Daemon ships live (`vocab-home`)

**Goal.** Make `vocab-home` a real co-deployable daemon a user can run, bind a
conversation to, close the browser, and have it answer over sync. The answer loop
is the existing `attachChatWorker`; this wave is about making the deploy real and
documented, not new answering machinery.

**Scope / files.** `apps/vocab/mount.ts`, `apps/vocab/epicenter.config.ts`, the
daemon entrypoint, deploy docs/README, the engine resolution
(`resolveDaemonStream` → byok-key ?? cloud-proxied-metered, ADR-0038). Verify the
child-doc observe loop hosts only `row.agent === 'vocab-home'` conversations.

**Acceptance.** A documented path to run the daemon locally; binding a conversation
to `vocab-home` and closing the browser yields an answer that appears on resync;
the existence-is-the-claim guard prevents any double-answer with a watching tab
(until wave 4 removes browser answering entirely).

**Handoff prompt.**
> In `apps/vocab` (worktree `/Users/braden/Code/.worktrees/epicenter-row-childdocs`,
> after wave 1), make the `vocab-home` daemon a real, documented deliverable per
> ADR-0024/0025/0041: a user co-deploys it, binds a conversation to `vocab-home`,
> closes the browser, and it answers over sync. The answer loop is the existing
> `attachChatWorker` (don't rewrite it). Confirm the child-doc observe loop hosts
> only conversations where `row.agent === 'vocab-home'`, and that `resolveDaemonStream`
> resolves byok-key ?? cloud-proxied-metered (ADR-0038). Write the co-deploy docs.
> Verify close-browser durability end-to-end. This is wave 2 of
> `specs/20260620T000000-vocab-answerer-collapse.md`.

---

## Wave 3 — Hosted managed worker — DROPPED by ADR-0043

This wave is not built. A use-case pass showed the Epicenter-hosted answerer
serves a phantom cell: Vocab is capability-free, so the client is the correct and
cheapest answerer (no durability to win), and the only other real app (Local Books)
needs a worker that **must** run where its data lives, which a hosted worker cannot
do without uploading the data. There is no hosted managed worker, no on-demand DO,
no queue, no wake route, and no internal-RPC child-doc connector. The economic
floor is the blind box (relay + anchor) plus the metered inference stream; nothing
per-user thinks-while-idle for free. See ADR-0043.

---

## Wave 4 — Vocab client answers via metered SSE (the collapse)

**Goal.** Vocab's capability-free agent answers **in the client** (ADR-0043): the
browser runs the shared answer core fed by the metered `/api/ai/chat` SSE stream
and sinks parts into the conversation child doc. This is the collapse, but the cut
is the **owner routing fork and the hosted-worker scaffolding**, not client
answering. The conversation substrate (table row to child doc to parts, ADR-0036)
stays; `vocab-home` keeps answering on the user's box.

**Scope / changes.**
- `ConversationView.svelte`: keep the client answer path, but drop the
  `owner: 'ephemeral' | 'durable'` routing fork and any "does the hosted worker
  answer this?" branch. The two agents are **client** (capability-free, browser
  answers) and **vocab-home** (daemon answers); the picker reflects that.
- Use TanStack AI on the client (`@tanstack/ai-svelte` `createChat` +
  `fetchServerSentEvents`) against `API_ROUTES.ai.chat.url(baseURL)` with
  `createAiChatFetch(auth.fetch)`; body `{ model: VOCAB_MODEL, systemPrompts:
  [VOCAB_SYSTEM_PROMPT], tools: [] }`. Sink the streamed parts into the
  conversation child doc via the shared answer core (ADR-0036). `chat.stop()` on
  unmount; render every `MessagePart` with an unknown-fallback.
- Remove the `owner` field from `AgentConfig` and the catalog; agents are
  distinguished by where the answer is produced (client vs daemon), not an owner
  enum. Rename the `this-device` agent to the **client** agent.
- Delete any hosted-worker scaffolding that landed (there is none if Wave 3 was
  never built); keep `epicenterMeteredEngine` only if the daemon's metered arm
  still uses it (ADR-0038), otherwise fold it into the client SSE path.
- Close PR #2127 (its owner fork is removed here).

**Acceptance.** The client answers the capability-free agent over metered SSE,
writing parts into the synced doc; `vocab-home` answers its conversations on the
user's box; no `owner` routing fork remains; one client answer path + one daemon
answer path; tests green. Run post-implementation-review + collapse-pass.

**Handoff prompt.**
> Make Vocab's client agent answer in the browser over the metered SSE stream per
> ADR-0043 (worktree `/Users/braden/Code/.worktrees/epicenter-row-childdocs`, after
> waves 1–2; Wave 3 is dropped). Use `@tanstack/ai-svelte` `createChat` +
> `fetchServerSentEvents` against `/api/ai/chat` with `createAiChatFetch(auth.fetch)`
> and `{ model: VOCAB_MODEL, systemPrompts: [VOCAB_SYSTEM_PROMPT], tools: [] }`,
> sinking parts into the conversation child doc via the shared answer core
> (ADR-0036). Remove the `owner: 'ephemeral' | 'durable'` routing fork from
> `AgentConfig` and the catalog; rename `this-device` to the **client** agent; the
> two agents are client (browser answers) and `vocab-home` (daemon answers).
> Keep `epicenterMeteredEngine` only if the daemon still needs it (ADR-0038).
> `chat.stop()` on unmount; render every `MessagePart` with an unknown-fallback.
> Close PR #2127. Run post-implementation-review + collapse-pass. Ground TanStack
> AI behavior against `TanStack/ai` via DeepWiki. This is wave 4 of
> `specs/20260620T000000-vocab-answerer-collapse.md`.

---

## Wave 5 — Agentic loop + doc-mediated approval — moved to Local Books

Not Vocab's milestone, and no longer a vague "deferred F." The design is ADR-0042
(the worker owns the loop over the doc-as-message-array; approval is a durable
single-writer doc region, the `cancelRequestedAt` pattern) plus ADR-0044 (approval
is a per-conversation policy: read-only / ask / auto, classifier deferred). Its
real consumer is **Local Books** (`20260620T180000-local-books-agent-over-sql.md`),
which has tools that bind a worker to the machine holding the data. Vocab has no
tools and never drives this loop. The loop-engine choice (hand-roll over the
TanStack adapters vs Vercel `streamText` vs roll-your-own) is decided at build time
in the Local Books spec.

## Open items carried forward

- Loop engine for the agentic loop (ADR-0042 open question), decided in the Local
  Books spec. Lean: hand-roll over `@epicenter/ai-adapters`'s TanStack adapters.
- Presence (#2128) as the dead-mailbox warning, fast-follow after wave 2.
- Browser-local BYOK (key never leaves the device): additive future option, does
  not disturb ADR-0043.
- `specs/zhongwen-conversation-deletion-refusal.md` hygiene (convert to ADR or
  delete) — separate pass.
