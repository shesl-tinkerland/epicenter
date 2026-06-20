# Chat transcript parts body

**Date**: 2026-06-18
**Status**: Draft
**Owner**: Braden
**Branch**: (to start) `feat/chat-parts-body`
**Implements**: [ADR-0036](../docs/adr/0036-answer-bodies-are-native-parts-arrays-streamed-into-y-text.md)
**Relates**: [ADR-0031](../docs/adr/0031-collaboration-is-addressed-single-writer-regions-in-a-child-doc.md) (addressing, deferred), [ADR-0021](../docs/adr/0021-actions-are-the-only-surface-that-crosses-a-process-boundary.md) (actions are the tools)

## One Sentence

Replace the chat transcript's single `content: Y.Text` per message with a `parts: Y.Array` of TanStack AI `MessagePart` shapes (text streams into a per-part `Y.Text`), so an assistant turn can carry tool-calls, on the current message-array envelope.

## How to read this spec

```txt
Read first:
  One Sentence
  Current State
  Target Shape
  Implementation Plan
  Success Criteria

Read if changing the design:
  Research Findings
  Design Decisions
  Edge Cases
  Open Questions

Scope boundary:
  This spec is the BODY (ADR-0036). The ENVELOPE (ADR-0031 addressing:
  entries/replies, dropping role/generationId/claim) is a separate, deferred
  migration. The parts body moves into the reply region unchanged when 0031 lands,
  so this is the durable half built first.
```

## Overview

The chat engine in `packages/workspace/src/ai/` stores one `Y.Text` of streamed prose per message. That cannot hold a tool-using answer (a SQL query the agent ran, interleaved with prose). This spec generalizes the body to an ordered parts array that mirrors TanStack AI's `MessagePart` union, keeping the streaming mechanism (suffix-append into `Y.Text`) that already works. zhongwen, which only ever produces text, is the byte-identical tracer; Local Books (agent-over-SQL) is the consumer the tool-call parts unlock.

## Motivation

### Current State

One conversation is a `Y.Doc` with a `Y.Array('messages')` of `Y.Map`s, one map per message (`packages/workspace/src/ai/chat-doc.ts:5`):

```txt
message Y.Map = {
  id: string
  role: 'user' | 'assistant'
  createdAt: number
  content: Y.Text          // token appends land here  <-- the single text run
  generationId?: string    // user turn: the assistant id it awaits (the work queue)
  cancelRequestedAt?: number
  finish?: ChatDocFinish   // assistant: write-once terminal outcome
}
```

The assistant writer streams into that one `Y.Text` (`chat-doc.ts:179`), and the reaction's `streamReply` only handles `TEXT_MESSAGE_CONTENT` and `RUN_ERROR` chunks (`chat-reaction.ts:225`).

This creates problems:

1. **No tool-calls.** A single `Y.Text` cannot represent "ran this SQL, then said this." Local Books' agent-over-SQL has no place to put the query it ran, so it cannot exist on this engine.
2. **No structured answers.** Extraction (a `Y.Map`), an approval (write-once decision), a tool-call log: none fit a flat text run.
3. **Body shape is bespoke, not the library's.** The chat stack speaks TanStack `MessagePart`, but the doc invents its own `content`-string shape, so every consumer reinvents the conversion instead of sharing one seam.

### Desired State

The body is an ordered parts array. Each part is a typed `Y.Map`; streamed text lives in a per-part `Y.Text`:

```txt
message Y.Map = {
  id, role, createdAt, generationId?, cancelRequestedAt?, finish?   // envelope unchanged
  parts: Y.Array<Y.Map>                                            // <-- replaces content
}

part Y.Map (text)        = { type: 'text',        content: Y.Text }
part Y.Map (tool-call)   = { type: 'tool-call',   id, name, arguments: Y.Text, input?, state }
part Y.Map (tool-result) = { type: 'tool-result', toolCallId, content, state }  // content capped
```

zhongwen's assistant message is `parts: [ { type:'text', content } ]`, identical in behavior to today's single `content`. Local Books interleaves `tool-call` and (capped) `tool-result` parts.

## Research Findings

### MessagePart mapping: 1:1 at parts, re-mapped at the envelope

TanStack's runtime message is `UIMessage { id, role, parts: MessagePart[] }`. Verified against installed types (`@tanstack/ai-client/dist/esm/types.d.ts`) and DeepWiki (`TanStack/ai`):

| TanStack part | Fields | We persist | Note |
| --- | --- | --- | --- |
| `TextPart` | `{ type:'text', content:string }` | yes, `content` as `Y.Text` | the streamed prose |
| `ToolCallPart` | `{ type:'tool-call', id, name, arguments:string, input?, state, approval?, output? }` | `{ id, name, arguments, input, state }` | the recipe; drop `output` |
| `ToolResultPart` | `{ type:'tool-result', toolCallId, content, state, error? }` | yes, `content` capped | truncated to a char budget + `[truncated: N of M]` |
| `ThinkingPart` | `{ type:'thinking', content }` | no | dropped |

**Key finding**: the part union is the natural body element. We persist nearly the whole union (text, tool-call recipe, capped tool-result), dropping only `thinking`, and the live text fields are `Y.Text` not `string`. The envelope (`UIMessage[]`, role-tagged) is a separate structural mapping, today the message-array and eventually ADR-0031's addressed regions.

### Persisting tool results: store capped, prune the prompt

WebSearch of the AI SDK docs (June 2026): the durable record stores tool results (`UIMessage`, results included, is "the source of truth" for restoring a chat), and token cost is managed by pruning old results from the *prompt* (`toolCalls: "before-last-N"`), not by omitting them from storage.

**Key finding**: storage and context are separate levers. **Implication**: persist a capped `tool-result`; prune old result content only when building the model prompt. Re-deriving on read (an earlier draft) breaks cross-device rendering for an unsynced local cache; storing makes the transcript a real synced artifact (rendering needs no cache, only generation does). The cap bounds storage; the recipe lets the model re-call the tool when the cap drops detail it needs.

**Implication**: one conversion seam (opensidian's `ui-message.ts` is the existing example) isolates TanStack drift; the tanstack-ai rule "render known parts, keep an unknown fallback" makes new part types additive.

### Streaming mechanism: native Y.Text beats an overwrite blob (grounded)

DeepWiki (`yjs/yjs`) on GC and merge behavior, for a single-writer region:

- A single client's N `Y.Text` inserts compress (`Item.mergeWith`); at rest ~O(content).
- Deleting those contiguous single-client items merges the GC structs (`GC.mergeWith`) to negligible residue.
- A `Y.Map` key set M times by one client GC-merges the M-1 superseded values to ~O(final).
- **Net**: re-serializing a whole JSON blob and overwriting one key each flush produces *more* update-log traffic than streaming small `Y.Text` inserts, while ending at *comparable* at-rest size.

**Key finding**: the size-floor fear in ADR-0031 is a multi-writer / multi-device-fragmentation phenomenon; a single agent streaming one answer into `Y.Text` compacts fine. **Implication**: keep streaming into `Y.Text` (this is also the existing mechanism); reject the overwrite blob. The flush-batching policy in `streamReply` (one transaction per 75ms or 512 chars) stays.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Body shape | 2 coherence | `Y.Array` of typed part `Y.Map`s (`MessagePart` shapes) | ADR-0036 |
| Streaming vehicle | 1 evidence | per-part `Y.Text`, suffix-append, current flush policy | DeepWiki `yjs/yjs`: native < overwrite on traffic, equal at rest |
| Reject overwrite blob | 1 evidence | rejected | same grounding; no floor win, more traffic |
| Persisted subset | 2 coherence | keep `text` + `tool-call{recipe}` + capped `tool-result`; drop `thinking` | ADR-0036; near-1:1 with the part union |
| Envelope | Deferred | keep messages-array + `role` + `generationId`-claim | ADR-0031 addressing win (N participants) unrealized at 1:1; body is forward-compatible with it |
| `text` on the snapshot | 2 coherence | keep, derived = concat of text parts | preserves `chatDocToPrompt` filter and existing predicates; adds `parts` for richer consumers |
| Result persistence | 1 evidence | store capped result; prune old results from the prompt | AI SDK: results are the persisted source of truth; tokens managed by prompt-pruning. Re-derive breaks cross-device (ADR-0036) |
| Result cap | 3 taste | char budget + `[truncated: N of M]`, applied by the writer | generic over tools (content is a string); SQL row formatting is the consumer's. Revisit when a real result exceeds it |
| Tool-call stream handling | Deferred to Phase 3 | the agentic tool loop (provider -> execute -> continue) | zhongwen (text-only) needs only Phase 1; Phase 3 needs its own spike (reuse TanStack's loop vs hand-roll) |

## The part catalog

```ts
// persisted part shapes (the Y.Map `type` discriminant)
{ type: 'text',      content: Y.Text }                              // streamed prose
{ type: 'tool-call', id: string, name: string,
                     arguments: Y.Text,   // partial JSON while streaming
                     input?: JsonValue,   // parsed, set once at input-complete (the recipe)
                     state: ToolCallState } // awaiting-input | input-streaming | input-complete | complete | error
{ type: 'tool-result', toolCallId: string,
                     content: string,     // capped: truncated to budget + [truncated: N of M]
                     state: ToolResultState } // streaming | complete | error
```

### Considered and rejected

| Candidate | Why rejected |
| --- | --- |
| Single `content: Y.Text` (today) | cannot hold a tool-call or its state |
| Overwrite a JSON parts blob (`y-keyvalue-lww`) | grounded: more update traffic, no at-rest win for a single-writer region |
| Persist *uncapped* `tool-result` | ~400KB/result for a year of rows, compounds; the cap keeps the self-contained benefit without the cost |
| Re-derive results on read (store none) | breaks cross-device render for an unsynced cache; prompt-pruning handles tokens instead |
| Persist `thinking` | noise, possibly sensitive, never needed on read |

## Architecture

The write path (reaction streaming an answer):

```txt
provider stream (ChatStream)
  TEXT_MESSAGE_CONTENT delta
    -> ensure trailing text part (append { type:'text', content: Y.Text } if last part isn't text)
    -> buffer; flush per 75ms / 512 chars: text.insert(text.length, buffer)
  TOOL_CALL_START                         [Phase 2]
    -> append { type:'tool-call', id, name, arguments: Y.Text, state:'awaiting-input' }
  TOOL_CALL_ARGS delta                    [Phase 2]
    -> args.insert(args.length, delta); state = 'input-streaming'
  TOOL_CALL_END                           [Phase 2]
    -> set input (parsed), state = 'input-complete'
  RUN_ERROR -> runError
  end -> writer.finish(completed | failed)   // envelope finish key, unchanged
```

The read path:

```txt
readChatDocMessages(doc)
  per message map:
    parts = [ snapshot each part Y.Map ]   // text: content.toString(); tool-call: {name,input,state}; tool-result: {content,state}
    text  = parts.filter(text).map(content).join('')   // derived, back-compat
  -> ChatDocMessage { id, role, createdAt, parts, text, generationId?, finish? }

chatDocToPrompt(messages)
  text-only message            -> { role, content: text }       // zhongwen: identical to today
  tool-call + tool-result      -> tool / tool-result ModelMessages   [Phase 3]
  old tool-result content      -> pruned from the prompt for tokens  [deferred]
```

## Call sites: before and after

### `appendAssistantMessage` writer (`chat-doc.ts:179`)

**Before**: creates one `content: Y.Text`, `appendText` inserts into it.

```ts
const content = new Y.Text();
map.set('content', content);
// ...
appendText(text) { content.insert(content.length, text); }
```

**After**: creates a `parts: Y.Array`; the writer appends/streams parts. Phase 1 exposes a text writer that lazily appends a trailing text part; Phase 2 adds tool-call part writers.

```ts
const parts = new Y.Array<Y.Map<unknown>>();
map.set('parts', parts);
// ...
appendText(text) {
  // ensure a trailing text part, then suffix-append
  let last = parts.get(parts.length - 1);
  if (!(last?.get('type') === 'text')) { last = newTextPart(); parts.push([last]); }
  (last.get('content') as Y.Text).insert(/* len */, text);
}
```

**Semantic shift to flag**: the "thinking marker" (empty trailing assistant message) is now an assistant map with an empty `parts` array, not an empty `content`. `findActiveChatDocGeneration` keys on `finish === undefined` + `createdAt`, so it is unaffected; but any reader checking `content` emptiness must check derived `text` instead.

### `readChatDocMessages` (`chat-doc.ts:218`)

**Before**: reads `content` (`Y.Text`) -> `text: content.toString()`.

**After**: reads `parts` (`Y.Array`), snapshots each part, derives `text` from text parts. No `content` branch: existing conversations are cleared, so a message without `parts` reads as no parts and is skipped.

### `streamReply` (`chat-reaction.ts:210`)

**Before**: buffers `TEXT_MESSAGE_CONTENT` deltas into one writer `appendText`.

**After**: Phase 1 unchanged in spirit (deltas -> the trailing text part via `appendText`). Phase 2 adds `TOOL_CALL_START/ARGS/END` handling that drives tool-call part writers. The flush policy (75ms / 512 chars) is preserved.

### zhongwen render (`apps/zhongwen/src/routes/(signed-in)/components/ConversationView.svelte`)

Phase 1 keeps rendering `ChatDocMessage.text`, so zhongwen needs no render change (text-only path). Tool-call rendering arrives with Local Books.

## Implementation Plan

### Phase 1: Parts container + text streaming (zhongwen tracer) — Build

> No chunk-reduction logic here. zhongwen produces only text, so there is one text
> part and the only operation is append-to-`Y.Text`, exactly what `chat-doc.ts` does
> today. The library-owned reduction (`StreamProcessor`: new-part-after-tool-call,
> arg accumulation, the state machine) lives in Phase 3, where it is reused, not
> reinvented. So Phase 1 has nothing to drift from.

- [ ] **1.1** Add persisted part types to `chat-doc.ts`: `ChatDocPart` union (text, tool-call, tool-result), and a `ChatDocMessage.parts: ChatDocPart[]` field alongside the kept derived `text`.
- [ ] **1.2** `appendAssistantMessage`: create `parts: Y.Array`; rewrite `appendText` to ensure-trailing-text-part then suffix-append; `finish` unchanged (envelope key).
- [ ] **1.3** `appendUserMessage`: user content becomes a single text part (a user turn is one text part).
- [ ] **1.4** `readChatDocMessages`: read `parts` only (no `content` branch), snapshot each, derive `text`; skip malformed parts (per-part version of the existing per-message skip).
- [ ] **1.5a** Clear existing zhongwen conversations (wipe the workspace local persistence / delete the `conversations` rows). No migration reader; this is a clean break.
- [ ] **1.5** `chatDocToPrompt`: walk parts; text-only messages produce the identical `{ role, content }` as today.
- [ ] **1.6** `observeChatDocMessages`: `observeDeep` already covers nested parts/Y.Text; confirm it fires on part-text inserts.

### Phase 2: Prove (zhongwen byte-identical) — Prove

- [ ] **2.1** Update `chat-doc.test.ts` / `chat-reaction.test.ts` for the parts shape; assert a text-only answer round-trips to the same `text` and same prompt as before.
- [ ] **2.2** Run zhongwen end to end: stream an answer, reload mid-stream (partial survives), confirm transcript and prompt identical to pre-change.
- [ ] **2.3** Typecheck + `bun test` in `packages/workspace`; svelte-check zhongwen.

### Phase 3: The agentic tool loop (Local Books-enabling) — needs its own design spike

> Not fully specified here on purpose. zhongwen does not need it, and it is gated on
> Local Books existing plus the QuickBooks read spike. The hard part is not parsing
> `TOOL_CALL_*` chunks; it is the loop itself (provider emits a tool-call -> the
> reaction executes the tool locally -> feeds the result back -> the provider
> continues), which TanStack's `ChatClient`/`chat()` already implements. Decide reuse
> vs hand-roll before building (Open Question 5).

- [ ] **3.1** Spike: can TanStack's agentic loop run with a doc sink (writing parts as it goes), or must the loop be hand-rolled in the reaction?
- [ ] **3.2** Reconcile `TOOL_CALL_START/ARGS/END` into tool-call parts; execute the (local) tool; write a capped `tool-result` part.
- [ ] **3.3** `chatDocToPrompt`: emit tool-call / tool-result ModelMessages from stored parts; add prompt-pruning of old results (the `before-last-N` policy).
- [ ] **3.4** Decide the `ChatStream` tool-passing contract (Open Question 2) so the provider sees the tool set (`tool-bridge.ts` `.definitions`).

### Phase 4: Remove / follow-ups

- [ ] **4.1** The HTTP `doc-generation.ts` path duplicates the flush + write policy; it is slated for deletion (per `chat-reaction.ts:46`). Collapse as its own clean-break (C4); do not couple new parts code to it.

(No compat shim to remove: existing conversations were cleared in Phase 1.)

## Greenfield scope: collapse, keep, refuse

Product sentence: *`chat-doc.ts` owns the conversation Y-layout; both generation runtimes enter through the writer API; the body is a parts array streamed into `Y.Text`.*

| Path | Verdict | Reason |
| --- | --- | --- |
| `chatDocToPrompt` reads `.text` shortcut | collapse now | walk parts natively; the shortcut hides that a message is parts. Stays byte-identical for text-only |
| stale `content` names / JSDoc | collapse now | this change makes them stale; rename to `parts` in the same commit |
| orphaned helpers after the body change | collapse now | delete if the migration leaves them callerless |
| writer API (`appendText`/`finish`) | keep | the single write seam shared by `chat-reaction.ts` and `doc-generation.ts`; the product sentence's "single path" |
| legacy `content` read branch | refuse (skip) | DECIDED: clear existing zhongwen conversations, no migration reader; `readChatDocMessages` reads only `parts`. Clean break |
| `doc-generation.ts` (cloud HTTP path) | separate clean-break | the dual-path collapse (C4). Deployed-endpoint contract; rides the stable writer API untouched here. Collapse as its own wave |
| ADR-0031 envelope (`generationId`, `role`, claim, cancel/finish) | refuse now | deferred (unrealized N-participant win) and the sync wire format. Refusing premature churn is the asymmetric win |

Gate framing: the acceptance check is **behavior byte-identical for text-only transcripts**, not files-untouched. The readers (`chatDocToPrompt`) should improve; only the write seam and the envelope stay fixed.

## Edge Cases

### Interrupted assistant (no tokens)

1. Reaction appends the assistant message (empty `parts`), then the worker dies.
2. `finish` is never written; `findActiveChatDocGeneration` ages it out by `createdAt`.
3. `chatDocToPrompt` drops it (derived `text` is empty). Same outcome as today.

### Malformed / foreign part (untrusted peer)

1. A synced part map lacks `type` or has a bad shape.
2. `readChatDocMessages` skips that part (prefers a hole over a crash, matching the existing per-message policy).

### Legacy conversation (cleared)

1. Existing conversations are cleared as part of this change; there is no migration reader.
2. A stray old-shape message (one with `content` and no `parts`) reads as no parts and is skipped: no crash, no half-rendered text.

### Tool-call args never complete

1. `TOOL_CALL_END` never arrives (worker died mid-args).
2. The tool-call part stays `state: input-streaming` with partial `arguments`, no `input`.
3. Read side must not re-run a recipe without a parsed `input`; render it as interrupted.

### Result larger than the cap

1. A tool returns more content than the char budget.
2. The writer truncates to the budget and appends `[truncated: N of M]` before persisting; the full result is never stored.
3. If a later turn needs the dropped detail, the model re-calls the tool (the recipe is present). A user-facing "refresh" can re-run the recipe against current data.

### A device without the tool's data

1. A device observes a synced Local Books conversation but has no local cache (or no provider access).
2. It renders the stored (capped) `tool-result` directly: no re-derivation, so no blank or divergent results.
3. Only generation needs the cache; rendering never does.

## Open Questions

1. **Legacy migration: RESOLVED, clear.**
   - Existing zhongwen conversations are cleared as part of this change; there is no migration reader. `readChatDocMessages` reads only `parts`. Chosen as a clean break (personal, low-data, no fear of churn).

2. **`ChatStream` tool-passing contract (Phase 2/3).**
   - The current `ChatStream` is `(messages, signal) => AsyncIterable<StreamChunk>`. Tool-using providers need the tool set too.
   - **Recommendation**: extend to `(messages, signal, tools?) => ...`, tools from `tool-bridge.ts` `.definitions`. Defer the exact shape until Local Books is the forcing consumer.

3. **Prompt pruning of old tool-results (Phase 3, deferred impl).**
   - Stored results are kept; the prompt should drop old result content to control tokens (AI SDK `before-last-N`).
   - **Recommendation**: record the policy now, implement when tool-results accumulate (after Local Books exists). Do not build pruning in Phase 1. Open.

4. **Result cap size and unit.**
   - A char budget is generic (content is a string), but how big? A few hundred rows of transactions is ~tens of KB.
   - **Recommendation**: start ~16KB chars + `[truncated: N of M]`; revisit against a real Local Books result. Open.

5. **Phase 3: how to reuse TanStack's reduction, not whether.**
   - `StreamProcessor` is documented for standalone chunk-transformation outside the chat client, and `ChatClient`/`chat()` already run the provider -> tool -> continue loop. Reimplementing either is the un-greenfield move, so the default is reuse. The real sub-question is the sink: incremental Yjs writes via `StreamProcessor`'s granular callbacks (`onTextUpdate`, `onToolCallStateChange`) if they expose deltas, or overwrite the message's JSON parts snapshot per debounced `onMessagesChange` if they do not.
   - **Recommendation**: spike `StreamProcessor`'s callback surface first; prefer granular-incremental, fall back to overwrite-snapshot. Both reuse the library's reduction; the choice is wire efficiency only. Open.

## Success Criteria

- [ ] zhongwen streams and reloads an answer byte-identical to pre-change (the tracer gate).
- [ ] A `tool-call` part (recipe) and a capped `tool-result` part (`content` truncated with a marker) round-trip through the doc and render on a device without the tool's data.
- [ ] `chatDocToPrompt` produces identical output for text-only transcripts.
- [ ] `packages/workspace` typecheck + `bun test` green; zhongwen svelte-check clean.
- [ ] No raw `Y` types leak past `chat-doc.ts` (the layout stays the single owner).

## References

- `packages/workspace/src/ai/chat-doc.ts` - the body layout to generalize (the whole change centers here)
- `packages/workspace/src/ai/chat-reaction.ts` - `streamReply` reconciler; flush policy to preserve
- `packages/workspace/src/ai/chat-doc.test.ts`, `chat-reaction.test.ts` - tracer assertions
- `apps/opensidian/src/lib/chat/ui-message.ts` - the persisted-parts to `MessagePart[]` seam to mirror
- `@tanstack/ai-client/dist/esm/types.d.ts` - `MessagePart` union ground truth
- `apps/zhongwen/zhongwen.ts`, `mount.ts` - the tracer consumer (`attachChatTranscript`, `attachChatReaction`)
- `packages/server/src/ai/doc-generation.ts` - the HTTP path slated for deletion; do not couple
