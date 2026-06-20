# 0025. Agent conversations are durable child docs driven by an observing worker

- **Status:** Proposed
- **Date:** 2026-06-16

## Context

Doc-as-wire chat (Zhongwen) already streams an assistant turn into a conversation
child doc by acting as a sync peer, so persistence, multi-device live view, and
refresh-resume fall out of one source of truth rather than separate features. But
it still needs an HTTP kickoff carrying the turn id, model, and prompts; the worker
snapshots the prompt once and never reads the doc back; cancellation is request
abort; and interactive tools are excluded. None of that survives moving the worker
to a user-owned always-on device (see [ADR-0024](0024-an-always-on-worker-runs-app-semantics-beside-the-app-blind-anchor.md))
or running it as a durable background service.

## Decision

An agent turn is a durable record in the conversation transcript (a child doc keyed
by a `conversations` row), not an HTTP request. The unanswered user message is the
work queue; there is no separate request table.

A conversation is one human and one agent, for life. The conversation row carries a
single immutable `agent: AgentId`, set once by the client that creates it. An
`AgentId` is the durable, configuration-authored address of an answering agent (a
hosted cloud agent, an always-on home daemon, a laptop daemon), not a per-install
node id and not a Yjs `clientID`. The agent is the address; the *worker* is the
process that answers as it (the role distinction is pinned in
[ADR-0024](0024-an-always-on-worker-runs-app-semantics-beside-the-app-blind-anchor.md)).
Presence can decorate the configured agent list
with live/offline status and capabilities, but it is not durable routing truth.
The binding is the row field. The cloud agent is `epicenter-cloud`, whose current
runtime is the metered HTTP route; a daemon answers when a conversation is bound
to its agent id.

This single field is the whole binding, and the collapse it buys is the reason it is
immutable. Because the agent never changes, the conversation's content only ever
reaches that one agent: a conversation bound to a home daemon is a hard guarantee
that nothing in it left the house. Attribution falls out for free and stays truthful:
the bound agent is who was addressed and who answered, for every turn, so no
per-message author or addressee field is needed, and the transcript child doc holds
no agent identity at all. That keeps it portable content while the binding lives on
the row (the portability seam), and it is why switching agents is a fork (snapshot
the transcript into a new conversation bound to a different agent, a visible act,
confirmable when it crosses a trust boundary) rather than a write here. A mutable
binding would break the privacy guarantee and force a per-message author field back
in to keep history honest; the immutable binding refuses both.

Each daemon reconciles the conversations bound to the agent it answers as: it
observes their transcripts, answers any unanswered turn, and is idempotent through
the durable client-minted `generationId` used as the assistant message id. There is
no claim and no race, because exactly one agent is named per conversation (and CRDT
merges could not enforce a claimant anyway).

The worker observes the transcript mid-answer so it can honor a durable, client-owned
cancel field, and it writes the write-once `finish`. Tool calls are the workspace's
published actions ([ADR-0021](0021-actions-are-the-only-surface-that-crosses-a-process-boundary.md));
when a call needs approval, the approval is a durable record in the doc that any
device resolves, not an in-process prompt. Dispatch is an optional wake nudge (the
doorbell), never the durable queue (the doc is the mailbox).

## Consequences

- Refresh-resume, multi-device live view, offline-survivable cancel, and
  multi-device approval all fall out of one source of truth. No server-to-client SSE
  is built: the worker appends to a `Y.Text` and Yjs sync is the transport. Only the
  model-to-worker token stream remains, and that is in-process for local inference.
- The worker gains a child-doc observe loop (a new mount-runtime capability) and a
  read-back path (a departure from the snapshot-once, write-only server-side
  doc-generation vertical, since deleted by
  [ADR-0033](0033-a-conversation-has-one-transport-and-two-triggers.md)). The loop hosts a live replica of
  each registered child doc, observes it, and tears it down when its row is gone.
  The app registers the conversation field on the mount; the per-body factory it
  supplies returns `{ onChange, [Symbol.dispose] }`, and `onChange` is the seam
  where answer, stream, and write-once `finish` live. Whether a turn is unanswered
  is a pure reader over the transcript snapshot (`findUnansweredTurn`), owned by the
  transcript layout module beside its sibling readers, so the worker and the
  transitional HTTP path share one predicate instead of inlining it twice. The
  factory runs once per body, so the only per-conversation state it holds is the
  in-flight stream (its abort), not a claim.
- The single-answerer guarantee is enforced on both sides of the transition, not by
  a lock. The observe loop hosts a live replica only of the conversations whose
  `agent` equals the agent the daemon answers as, so the worker is built and runs only
  for those: filtering the open set, not abstaining after the fact, is what keeps the
  app-aware worker out of the app-blind anchor's availability job
  ([ADR-0024](0024-an-always-on-worker-runs-app-semantics-beside-the-app-blind-anchor.md)).
  The worker itself carries no designation concept. The browser supplies the
  complementary half: it nudges the cloud agent's HTTP route only when the
  conversation is bound to the cloud agent (`epicenter-cloud`), and does nothing for
  a conversation bound to a daemon agent (that daemon answers over sync). So a
  daemon-bound conversation is answered only by its daemon and a cloud-bound one only
  by the HTTP path; neither ever answers a turn the other does. The bound agent is
  immutable, so this split never flips mid-conversation. The cloud agent is therefore
  never deleted (it is an always-available answerer whose runtime is the metered,
  serverless route); what C4 removes is the `null`-as-cloud special case, not the
  route.
- The conversation is a row plus a transcript child doc, and that split is the
  portability seam. The agent is named once on the row at creation and never
  reassigned; the transcript carries no agent identity, so it stays portable content.
  To run a history against a different agent you fork it: snapshot the transcript into
  a new row bound to that agent (confirmable when the fork crosses a trust boundary,
  the only place content moves between agents). Naming an agent needs a configured
  catalog, not a presence-only roster: the durable address is the stable `AgentId`.
  Presence may tell the UI whether that agent is live right now, but a configured
  offline daemon can still be the correct binding because the conversation doc is
  the durable mailbox it will read when it wakes.
- This is the conversation and transport layer. The bulk-mutation trust model
  (emit bounded data, dry-run on a forked Y.Doc, approve the computed effect) is
  Model 1 of the AI-workflows consolidated design and is unchanged here.
  Arbitrary-code agents are that design's Model 2 lane.
- Forecloses a `generation_requests` table, a CRDT claim field (CRDT merges cannot
  enforce a single claimant), and runtime claim-pools (deferred until N
  interchangeable workers per room actually exist, and then via a compare-and-set
  action, not a raw field).

## Considered alternatives

- **Keep the HTTP kickoff.** Rejected: an open request is not durable, cannot move
  to an always-on device, and cannot survive disconnect.
- **A durable `generation_requests` table.** Rejected: the unanswered turn already
  encodes the work; a parallel table is a second source of truth to reconcile.
- **A Yjs claim field per turn.** Rejected: CRDT merges cannot enforce a single
  claimant, so two workers both "win"; a per-conversation bound agent plus an
  idempotent id is sufficient and simpler.
- **A separate table mapping conversations to agents.** Rejected: the doc is
  the only wire and control plane (no side channel), and a parallel table is a
  second source of truth to reconcile, the same reason the `generation_requests`
  table was rejected. The row already syncs to every device and to the worker's
  filter, so the binding belongs on it.
- **Per-message targeting (a different agent per turn).** Rejected, and the
  rejection is load-bearing, not incidental. Per-turn addressing would put agent
  identity in the transcript and let one thread's content reach several agents,
  which dissolves the privacy guarantee (a "private" thread could ship earlier
  turns to a more public agent) and forces a per-message author field to keep
  attribution honest. The whole-conversation binding is the direct-message model:
  a thread is with one agent; to use another you start a new thread (a fork).
  Mixing agents in one thread is a future group shape (a participant set on a
  different surface), never a weakening of the one-agent default. A turn never
  picks its own agent.
