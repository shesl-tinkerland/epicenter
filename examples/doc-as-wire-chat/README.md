# doc-as-wire chat

A runnable demonstration of ADR-0024 / ADR-0025: **a separate, always-on actor
answers a conversation by writing into a synced document, and another peer
watches the answer stream back — the doc is the wire.** No HTTP request/response
between client and actor, no server-sent events.

It reuses the production primitives unchanged:

- `@epicenter/sync` — the STEP1/STEP2/UPDATE wire protocol the real relay speaks.
- `attachChildDocActor` — the REAL observe loop: host a live transcript replica
  for every conversation bound to this actor's agent, answer each one.
- `attachChatTranscript` / `attachChatActor` — the transcript layout and the
  per-conversation append loop (claim -> stream into the `Y.Text` -> write `finish`).

The only thing faked is the model (an echo `ChatStream`), and only when no
`GEMINI_API_KEY` is set.

## The three roles, as three processes

```txt
relay.ts    the RELAY   app-blind byte router; one Y.Doc per room, fans out frames
actor.ts    the ACTOR   always-on daemon; runs the observe loop, streams answers in
client.ts   the CLIENT  thin REPL; binds a conversation, writes turns, renders the doc
```

## Run it (3 terminals)

```sh
bun run relay      # terminal 1
bun run actor      # terminal 2  (answers as agent "demo-actor")
bun run client     # terminal 3  (binds a conversation to "demo-actor")
```

Type in terminal 3 and watch the reply stream in character by character.

## The slices, and how to see each

**Stream (S1).** Type a message; the actor (a separate process) streams the reply
into the synced transcript. Watch terminal 1: it only logs `fwd ... Nb (opaque
bytes)` — the relay never decodes an app field.

**Durable cancel (S3).** While a reply is streaming, type `/cancel` and Enter. The
actor stops mid-stream and writes a `cancelled` finish. The cancel is a durable
field in the doc, so it survives a disconnect — not an in-process abort.

```sh
bun run smoke:cancel
```

**Agent binding (S4).** A conversation carries an immutable `agent`. The actor's
observe loop hosts only conversations bound to the agent it answers as; everything
else it ignores. See it both ways:

```sh
AGENT=demo-actor bun run client    # answered
AGENT=other      bun run client    # ignored — nobody runs "other"
```

```sh
bun run smoke:binding
```

**Real inference (S5).** Set a key and the same actor uses Gemini instead of the
echo, behind the identical `ChatStream` contract (built exactly as
`apps/zhongwen/mount.ts` builds it):

```sh
GEMINI_API_KEY=... bun run actor
```

The actor logs the provider path:

```txt
[gemini] request started · model=gemini-3.5-flash · messages=3
[gemini] still waiting for first chunk after 5000ms
[gemini] first chunk after 7420ms · type=TEXT_MESSAGE_CONTENT
```

If Gemini fails before text arrives, the client renders the failed finish instead
of looking stuck:

```txt
assistant:  [failed: stream-error] ApiError: ...
```

For the fast local echo path, run the actor without the key:

```sh
env -u GEMINI_API_KEY bun run actor
```

## Non-interactive checks

```sh
bun run relay        # terminal 1
bun run actor        # terminal 2
bun run smoke            # S1: observe -> stream -> finish (completed)
bun run smoke:cancel     # S3: cancel mid-stream -> finish (cancelled)
bun run smoke:binding    # S4: bound agent answers, others are ignored
```

## How it maps to the architecture

```txt
root doc (room "epicenter-demo")
  conversations table: rows { id, agent }          ← the binding lives on the row

transcript child doc (room "epicenter-demo.conversations.<id>.transcript")
  derived 1:1 address; the actor's observe loop and the client opener
  compute the SAME guid with zero coordination (single-owner derivation)
```

## Scope

In-memory relay (restarting it clears history — durable storage is the **anchor's**
job, a later slice). No auth, no IndexedDB, no Iroh. Env: `PORT` (default 8787),
`ROOM` (workspace room, default `epicenter-demo`), `AGENT`, `CONV`, `GEMINI_API_KEY`.
