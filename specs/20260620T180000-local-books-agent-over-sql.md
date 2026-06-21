# Local Books: a client-loop agent over a daemon-hosted SQL mirror

Status: Draft. Date: 2026-06-20 (collapsed onto the client-loop model 2026-06-21).

Local Books is a local-first product where an agent answers questions about your books by running SQL over a local SQLite mirror, and proposes mutations you approve. The chat loop runs **in the client**, in-memory, the way Vocab and tab-manager already run it; the books data and the SQL tool live on a **daemon that is a passive action-host**, never a conversation worker. The client dispatches a tool call to that host and feeds the result back into its own loop. There is no daemon observing conversations, no conversation written into a synced doc, and no always-on listener.

This collapses the earlier daemon-answerer design (an observe-loop worker streaming parts into a synced child doc) onto the simpler shape the primitives already support. It supersedes, for this product, the worker-owned loop (ADR-0042), the doc-mediated approval policy (ADR-0044), and the local-data-answers-on-the-daemon case of ADR-0043. It follows Vocab's un-unification onto client `$state` + per-id LWW KV (ADR-0046, incoming) rather than doc-streaming. Harvest these reversals into `docs/adr/` on landing.

## The invariant: no always-on answerer; the daemon only hosts actions

The justification for a daemon is still **capability locality**: the SQLite mirror of your books lives on one machine, and the SQL tool must run there. But hosting a capability is not answering. The daemon:

- owns the local SQLite mirror and runs scheduled QuickBooks pulls,
- registers a small, fixed action set and **publishes it as a presence manifest** (`presence_protocol.ts`: the wire carries each peer's full action manifest with input schemas, explicitly "to hand to an AI tool layer with no second round trip"),
- answers a dispatched action via `runInboundDispatch` (look up the action key, `invokeAction`, return `Ok`/`Err`),
- is otherwise idle and hibernation-friendly: it holds one presence connection so clients can discover and reach it, not N conversation replicas it observes.

Cloudflare stays two dumb pipes, both hibernating between events: the metered `/api/ai/chat` SSE inference stream (ADR-0033/0038) and the dispatch relay (`room/core.ts`). Neither runs app semantics; neither is a per-user always-on worker.

## The loop runs in the client (mechanism, all pre-built)

```txt
1. daemon  -> presence_publish { actions: { books_sql_query, mark_reviewed, add_note }, agentId: 'local-books' }
2. client  <- presence frame carries the full manifest (input schemas included)
3. client     actionsToAiTools(manifest) -> ToolDefinition[] (mutations carry needsApproval: true)
4. client     createChat({ tools }) runs the loop IN-MEMORY; on a tool-call, execute(...) ->
                 v1 single-device: invokeAction in-process against the local SQLite (no box)
                 v2 multi-device:  dispatch({ to: daemonNodeId, action, input }) over the relay
5. daemon  -> runInboundDispatch: invokeAction against the local SQLite -> Ok/Err back over the same socket
6. client     feeds the result into the loop and re-prompts; renders parts from its own $state
7. approval   needsApproval mutations pause at the in-memory client gate (the tab-manager mechanism); on
              approve, execute runs (v1) or dispatches (v2)
```

tab-manager is already steps 3, 4, 6, 7 with an in-process `execute`. Local Books is tab-manager whose `execute` dispatches to a remote action-host for v2, discovered via presence. Nothing in this loop touches a synced conversation doc, an observe-loop, or `existence-is-the-claim` (one client owns the loop, so there is no contention to guard).

## Locked product direction (mirror, not ledger)

Settled in an earlier greenfield grill; harvest into `docs/adr/` when this lands:

1. **Mirror plus overlay, not a ledger.** QuickBooks is the system of record; Local Books reflects and annotates, never authors.
2. **SQLite, not Yjs, for the facts.** Facts are a re-pullable cache of remote truth, so a CRDT earns nothing. The conversation and the overlay (notes, review state) are the only client-owned synced surfaces, and they sync as per-id LWW KV, not a doc.
3. **Faithful per-provider raw is canonical.** QuickBooks-only, concrete, no provider abstraction until provider #2 disagrees.
4. **No Markdown in v1.** The read path is agent-over-SQL.
5. **Append-only observations plus a local overlay keyed to the QuickBooks logical id.** Each sync appends; nothing updates or deletes a fact in place.
6. **No write-back.** Append-only observation diffs give free change-tracking of your own books without competing with the accountant who owns the QuickBooks edits.

## Conversation: client state, not a synced doc

The conversation is the client's in-memory chat state (the Vocab/ADR-0046 shape), optionally persisted to a per-id LWW KV store for resume. There is no doc-as-transport, no native streaming into `Y.Text`, no daemon writing parts. Consequences, accepted:

- **Live streaming is the client's own loop.** The metered SSE stream (or a local/BYOK model) feeds the client; the client renders from `$state`. No second cross-network live channel, and no daemon stream to fan out.
- **Resume is via KV snapshots, not a live doc.** If the client persists settled messages (including `tool-call` / `tool-result` parts) to per-id LWW KV, another device reads the conversation and renders without any cache, and audit stays free. Live tokens are not multi-device; settled messages are. Acceptable for a one-human-one-agent product.
- **Closing the client stops the reasoning, not necessarily the work.** The LLM loop is client-owned and ephemeral: close the tab and the agent's reasoning stops. Fast tools are bounded RPC that return inline, so they need nothing durable. A genuinely slow tool, when one arrives, is a dispatched job that acks immediately and keeps running on the daemon, reporting into a synced record the client observes (see "Slow tools are jobs" below). So durable background *work* is recoverable without an always-on chat listener; durable background *reasoning* is the deliberate refusal.
- **Approval is in-memory and single-client.** You approve where you chat; since the loop is client-owned there is only one place to approve. ADR-0044's three policies (`read-only` / `ask` / `auto`) still hold as client state; `read-only` is still a real floor because the client simply does not offer the mutation actions to the model.

## Slow tools are dispatched jobs that report into a doc (later tier)

The collapse appears to give up long-running work, but it does not: it changes how that work is triggered and reported. A two-tier tool model recovers async jobs without reviving the always-on observe-loop.

```txt
fast tool   dispatch -> run -> Result inline           books_sql_query, mark_reviewed, add_note
slow tool   dispatch -> ack { jobId } immediately;      the daemon keeps running the job and writes
            then runs on the daemon, writing progress    progress / results into a synced job record;
                                                         the client observes it and renders as it syncs
```

Why this stays inside the invariant: the **daemon writes** the job record and goes idle; the **client observes** it. The direction is the reverse of the deleted design, where a daemon observe-loop watched conversation docs for turns. The daemon never listens for anything; a dispatch is the only trigger, and a job is a specific bounded thing it was told to do. The job record is durable (the anchor persists partial progress), so a job survives the client closing: the LLM loop dies with the tab, but the work completes on the already-on data daemon and lands in the record, where the human picks it up on re-open. The record can be a child doc (incremental progress observed live) or a per-id LWW KV entry (final result only); the durable, synced, client-observable property is the point, not the CRDT.

The honest boundary: this makes background *work* durable, not background *reasoning*. If the model needs the job result to keep reasoning, the client stays open and awaits the record, or the human re-engages when it lands. For a human-driven books agent that is the right shape, not a gap. This is the actor/job concept the actors stack (PR #2077) was gesturing at, minus the always-on chat runtime: a job is an actor a dispatch wakes, not a resident chat answerer.

Scope: **not v1 or v2.** Every core Local Books tool is fast (a SQL query and two overlay writes all return inline). The candidate slow tool is an agent-triggered QuickBooks sync or a bulk reconcile pass over thousands of transactions, both real but later features. Build the job tier when the first genuinely slow tool exists, not before; the fast-RPC path stays the simple baseline.

## The inference trade (v2 multi-device): accepted

The loop runs wherever the asking device is, so inference runs there too.

- **v1 single-device: fully local, nothing leaves.** Client and daemon co-locate; the loop, the SQL tool, and a local model all run on one box. Identical privacy to any daemon-loop design, and strictly simpler.
- **v2 multi-device: cloud inference, accepted.** A phone client cannot host a capable local model, so it uses the metered (or BYOK) stream; tool results (raw SQL rows) ride into that prompt, so books data reaches the inference provider. This is the same explicit cloud opt-in as ADR-0033, never silent. The ADR-0043 invariant still holds: no Epicenter *worker* processes the books; the relay is blind transport, the client is the user's own device, inference is a chosen backend. The capability given up (ask from the phone while inference stays on the desktop) is the one thing the deleted daemon-loop did better, and it is the price of the collapse.

## Shape

```txt
apps/local-books/                Epicenter root (app folder = root)
  epicenter.config.ts            export default localBooks({ agentId: 'local-books' })

daemon = action-host (owns the data, never answers)
  facts (NOT synced)             local SQLite mirror of QuickBooks:
                                   observations  raw_payloads  sync_runs  overlay_*
                                   + current_state / observation_diff views
  scheduled QuickBooks pulls     append-only; populate / refresh the mirror
  action registry (ADR-0021):
    READ   books_sql_query(sql)        query, auto-runs
    WRITE  mark_reviewed(ids)          mutation, needsApproval
           add_note(qbId, note)        mutation, needsApproval
  v2: publishes the manifest + agentId via presence; answers dispatches via runInboundDispatch
  NEVER: bash, file I/O, write-SQL, a raw Y.Doc handle, an LLM, an observe-loop

client = the loop (chat + approval + render)
  createChat in-memory; tools built from the action manifest (actionsToAiTools)
  execute: in-process (v1) or dispatch to the daemon node (v2)
  inference: metered SSE / BYOK / local (ADR-0033/0038)
  conversation: $state, optionally persisted to per-id LWW KV for resume
  approval: in-memory gate on needsApproval mutations
```

## Slices

1. **QuickBooks OAuth read spike (sandbox).** Daemon pulls; populate the SQLite mirror; observations append-only. Risk-first, proves the data path before any agent.
2. **Client-loop chat over in-process read tools, single-device.** `createChat` with `books_sql_query` built from the local action registry, executed in-process; the agent answers questions over local SQL with zero box involvement. No daemon answerer, no doc.
3. **Write tools plus the approval gate.** `mark_reviewed` / `add_note` as `needsApproval` mutations; ship `read-only` / `ask` / `auto` as client policy; the in-memory TanStack gate; classifier deferred.
4. **Multi-device: dispatch and presence.** Run the daemon as an action-host on the box (publish manifest + agentId via presence); a second client (phone / browser) discovers it, builds tools from the manifest, and swaps `execute` to `dispatch`. Cloud inference on the client; the daemon answers each dispatched tool call. Conversation persists to per-id LWW KV so it resumes from any device against the same daemon.

## Open items

- Placement: `apps/local-books` is its own root, reusing the CLI / relay / agent and the action + presence + dispatch primitives, not the books facts or the conversation as a synced doc.
- Conversation persistence: confirm the per-id LWW KV shape for settled messages (parts included) so multi-device resume and audit hold without a cache; this is the Vocab/ADR-0046 substrate.
- Manifest-to-tools at runtime: the client builds `ToolDefinition[]` from the presence manifest; confirm `ActionMeta` carries enough (title, description, input schema) for every tool, or add what is missing at the action-definition layer.
- Observation-table grain: one table plus `entity_type` plus `raw_json` plus extracted query columns (leaning), vs per-entity-type tables.
- Bound transaction volume and which QuickBooks entities v1 mirrors.
- Job durability on the daemon (only when the job tier is built): a slow job that outlives the client must also survive the *daemon* restarting (a laptop daemon sleeping mid-job). The record persists partial progress via the anchor; whether a job resumes from it or re-runs is a per-job choice (a QuickBooks re-pull is append-only and safe to re-run).
- Harvest on landing: the mirror-not-ledger and SQLite-not-Yjs decisions, and the client-loop collapse (superseding ADR-0042/0044 and the local-data case of ADR-0043 for this product).
</content>
