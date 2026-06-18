# Zhongwen Daemon and the V0 Exit

**Date**: 2026-06-17
**Status**: Draft
**Owner**: Braden
**Builds on**: `specs/20260616T225034-actors-buildout.tracker.md` (V0 done-when), `docs/adr/0024-an-always-on-actor-runs-app-semantics-beside-the-app-blind-anchor.md`, `docs/adr/0025-agent-conversations-are-durable-child-docs-driven-by-an-observing-actor.md`
**Lands on**: a fresh branch off `origin/main` after PR #2077 merges (do not stack on the `codex/...` branch)

## One Sentence

Give the Zhongwen app a daemon entry so its always-on actor actually runs, then prove the V0 exit in the real app: a daemon answers a conversation bound to its agent, the browser abstains, exactly one answer, cancel survives a disconnect.

## Why Now

PR #2077 lands the always-on actor primitives and a runnable proof (`examples/doc-as-wire-chat`), but that example proves the model in isolation: a standalone actor process with no competing transport. The real app, Zhongwen, has never run the daemon, because there is no `apps/zhongwen/epicenter.config.ts` for `epicenter up` to load. So the V0 done-when ("a phone and a desktop see the same streamed reply over hosted sync, cancel works after a disconnect, 0 duplicate streams") is unproven where it matters: in a shipping app, over hosted sync, against the browser's competing HTTP generation path.

## The Roles, So The Plan Reads Cleanly

Four roles, never fused (ADR-0024):

- **relay**: moves sealed bytes, blind to plaintext, stores nothing durable.
- **anchor**: always-on, durable, app-blind replica; the availability promise.
- **actor**: the running process that observes docs, thinks, and writes answers.
- **agent**: the durable address a conversation binds to; an actor answers *as* an agent.

`epicenter.config.ts` is none of these. It is the declaration that names which app a folder runs and which agent its actor answers as. The daemon loads it; the actor (the observe loop) responds, and only to conversations whose `row.agent` matches that agent. The doc's `agent` field decides who answers, never the topology.

## The Honest Finding: Designation (R) Is Already Built

Investigation against the merged tree shows both halves of single-answerer designation already exist. This is NOT new work for thread 2; verify it still holds, then build on it.

- **Daemon half** (`packages/workspace/src/document/child-doc-actor.ts`): the observe loop filters `.filter(isDesignated)` where `isDesignated(rowId) = row.agent === selfAgentId`. The daemon hosts only conversations bound to its agent.
- **Browser half** (`apps/zhongwen/src/routes/(signed-in)/components/ConversationView.svelte`, `nudgeBoundAgent()`): the browser skips its HTTP kickoff unless `agentConfig(agent)?.runtime === 'cloud'`. A `zhongwen-home`-bound conversation never triggers the cloud path.
- **Catalog** (`apps/zhongwen/zhongwen.ts`): `ZHONGWEN_AGENTS` already defines `epicenter-cloud` (`runtime: 'cloud'`) and `zhongwen-home` (`runtime: 'daemon'`); the conversation row carries an immutable `agent` set at creation.

Both sides key off the same `agent` address, so the double-answer is already structurally prevented for daemon-bound conversations. The only missing artifact is the config file.

## Slices (verify-first, smallest honest steps)

### Slice 0: Verify the premise (read-only)

Do not trust the finding above; confirm it on freshly merged `main`.

- Re-read the daemon filter, the browser `nudgeBoundAgent` runtime check, and that a Zhongwen conversation carries an immutable `agent` at creation.
- Confirm what `packages/server/src/ai/actor-over-room-sync.test.ts` test 3 currently asserts (one map vs two), so it is known whether any R work remains or it is purely config plus proof.

Exit: a one-paragraph written confirmation of what is built and what (if anything) is not.

### Slice 1: Add the daemon config

Create `apps/zhongwen/epicenter.config.ts`:

```ts
import { asAgentId } from '@epicenter/workspace';
import { zhongwen } from './mount.js';

export default zhongwen({ agentId: asAgentId('zhongwen-home') });
```

Everything else (nodeId from `.epicenter/node.json`, the Unix socket, the actor loop, sync) wires automatically. The mount factory already accepts `agentId`, the actor is already registered (`actors.conversations.messages`), and the designation predicate is built in `workspace.ts`.

Exit: `epicenter up` in `apps/zhongwen` starts a daemon without error.

### Slice 2: Prove the V0 exit in the real app

The slice where reality bites. Run the daemon, open Zhongwen in a browser, create a conversation bound to `zhongwen-home`, send a turn. Assert the V0 finish line:

- the daemon answers (streams the reply into the synced doc),
- the browser does NOT fire the HTTP kickoff (it abstains on a non-cloud agent),
- exactly ONE assistant message after CRDT merge,
- cancel mid-stream writes `finish: cancelled`,
- it survives a disconnect (durable cancel, durable answer).

The bugs found here are the real content of thread 2: auth/session for the daemon, room provisioning, and the browser rendering a daemon-authored answer it did not kick off.

Exit: a real two-surface run (or an integration test against a live room, in the shape of `actor-over-room-sync.test.ts`) showing one answer, durable cancel, and survival across reconnect.

### Slice 3: Collapse pass on the new surface (rides along)

The new files are greenfield. Per the collapse-pass Implementation Gate, audit every new helper, wrapper, and file-split. First targets: the example's `smoke.ts` / `smoke-cancel.ts` / `smoke-binding.ts` trio and the `transport.ts` / `conversations.ts` helpers; plus one-caller boundaries in the new workspace files. Leave the `chat-actor.ts` and `doc-generation.ts` flush-policy duplication alone: that is the deliberate C4 deferral.

### Slice 4: C4, delete the HTTP generation path (optional, now unblocked)

Once Slice 2 proves the daemon answers, the HTTP generation path (`packages/server/src/ai/doc-generation.ts`) can be deleted, which kills the double-answer structurally instead of relying on the browser conditional. Bigger, separate slice; gate it on Slice 2 passing. See C4 in the buildout tracker.

## Open Questions

- **OQ1 (Slice 2 linchpin): the daemon's auth story.** Hosted sync needs an authenticated session (`openEpicenterRoot` builds the session from the auth client). A real two-device proof needs the daemon machine signed in. How does the daemon authenticate, and what is the minimal login flow for a machine running `epicenter up`?
- **OQ2: room provisioning.** Does the daemon join the same room the browser uses with zero coordination (the derived child-doc guid), the way the example does? Confirm against hosted sync, not just the local in-memory relay.
- **OQ3: the browser rendering a foreign answer.** The browser must render an assistant message authored by the daemon, which it never kicked off. Confirm the transcript observer renders it identically to a self-kicked answer.

## Out Of Scope

The cloudless Iroh anchor (thread 3, `specs/20260616T185740-cloudless-home-anchor-direction.md`) is not part of this. This thread proves the actor half over the existing hosted relay/anchor; the self-hosted anchor is a later, separate slice that depends on this being solid.
