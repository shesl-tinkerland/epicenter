# Vocab

Bilingual Chinese-English chat app for learning Mandarin. Users ask questions in English; the AI responds with mixed English and Chinese. The client automatically annotates Chinese characters with pinyin using `<ruby>` tags. The system prompt tells the AI to never include pinyin itself.

## How it works

**Chat over a synced doc (doc-as-wire)**: Each conversation's transcript lives in its own synced Yjs child doc, a `Y.Array('messages')` of append-only `Y.Map`s (one `Y.Text` of content per message). The client sends by appending a user message map (carrying a fresh `generationId`, the durable id of the assistant answer this turn awaits). An **in-process peer** then claims and answers that turn (ADR-0033): for a cloud-bound conversation the browser tab runs the answerer itself (`attachChatBrowserAnswerer`), sourcing tokens from the **Epicenter provider** (the metered `/api/ai/chat` SSE stream) and writing each delta straight into the same doc; for a daemon-bound conversation the always-on daemon worker (`attachChatWorker`) answers ambiently over sync. Either way the UI renders from a doc observer, so persistence, multi-device live view, and refresh-resume are consequences of one source of truth rather than separate features. Claiming is existence-based (`findUnansweredTurn`), so a tab and a daemon never answer one turn twice. Stop is a durable cancel written to the doc (`requestCancel`), so it works from any device. The cloud never writes the doc: it is a blind relay plus a stateless metered inference stream. The doc layout and the answerer are owned by `@epicenter/workspace/ai` (`chat-doc.ts`, `chat-browser-answerer.ts` / `chat-worker.ts`).

**Markdown + pinyin**: Assistant messages are parsed with `marked` (GFM, breaks enabled) into HTML, then `annotateHtml()` in `src/lib/pinyin/annotate.ts` walks text nodes (splitting on HTML tags via regex) and wraps CJK runs with `<ruby>` pinyin tags using `pinyin-pro`. Output is sanitized with DOMPurify (allowing ruby/rt/rp), memoized via `$derived` in `AssistantMessagePart.svelte`, and rendered via `{@html}` inside `<div class="prose prose-sm">`.

**Workspace state**: `vocabWorkspace` in `vocab.ts` is the shared isomorphic definition. It defines `epicenter-vocab`, the `conversations` table (the cheap list: title and timestamps), the `conversations.messages` child doc layout, the `showPinyin` KV value, and the Vocab model constant. Transcripts are not a table; they are per-conversation child docs opened as `vocab.tables.conversations.docs.messages.open(conversationId)`. `openVocabBrowser()` opens the definition with the signed-in browser connection, which attaches local storage, root collaboration, and the child-doc runtime.

```txt
defineWorkspace()
  -> vocabWorkspace
    -> openVocabBrowser() opens with a browser connection
    -> vocab() opens without a browser connection, then adds daemon infrastructure
```

**UI state**: split by lifetime. `src/routes/(signed-in)/+page.svelte` owns the page-local root-doc concerns: the conversation list (the `conversations` table), which conversation is active, and CRUD. The per-conversation runtime lives in `ConversationView.svelte`, mounted via `{#key activeConversationId}`, so the transcript doc gets a real component lifecycle (opened in setup, disposed in `onDestroy`). `ConversationView` opens the active conversation's `messages` child doc (IDB + websocket), renders messages from a doc observer, and derives liveness from update recency, never stored: a trailing assistant message with no `finish` and recent updates is streaming, the same message gone quiet past a ~3s grace window is interrupted (offer retry), and the terminal outcome is the message's write-once `finish` key.

**Auth**: Google OAuth through the shared Epicenter auth/session path. The browser runtime is built through `createSession`, so storage and sync only mount after a signed-in identity provides `ownerId` and WebSocket transport functions.

**Providers**: `@epicenter/constants/ai-providers` owns the shared servable model registry. `vocab.ts` owns Vocab's Gemini model.

## File map

```
src/
  lib/
    platform/auth/auth.ts  # OAuth auth client
    session.ts             # createSession + openVocabBrowser singleton
    pinyin/
      annotate.ts          # annotateHtml(): CJK detection and ruby annotation
  routes/
    +layout.svelte         # Root layout with Toaster
    +layout.ts             # SSR disabled (CSR only)
    (signed-in)/
      +page.svelte             # Main layout: sidebar + chat area + pinyin toggle
      chat/
        system-prompt.ts       # AI instructions (mix languages, no pinyin, simplified only)
      components/
        ConversationView.svelte  # Keyed per-conversation runtime: doc, observer, liveness, send/stop
        ChatMessage.svelte       # Renders one ChatDocMessage; delegates assistant text to AssistantMessagePart
        AssistantMessagePart.svelte # Markdown parse + pinyin annotate + DOMPurify, memoized via $derived
        ChatInput.svelte         # Textarea + send button, Enter to submit
        VocabSidebar.svelte   # Sidebar conversation list with create/switch/delete
vocab.ts                    # Shared isomorphic model (tables, KV, conversation child docs)
vocab.browser.ts            # openVocabBrowser runtime wiring
```

## Key decisions

- The conversation list lives in the root workspace doc (`conversations` table); each transcript lives in its own synced child doc. There is no `chatMessages` table.
- The doc is the wire: an in-process peer (the browser tab or the daemon) appends the answer to the transcript doc; the cloud is only a metered inference stream, never a doc writer (ADR-0033). There is no kickoff and no dual write to reconcile.
- Liveness and terminal outcome are not stored as a status field. Liveness is derived from update recency; the outcome is the single write-once `finish` key.
- SSR is disabled; the app is CSR-only.
- The system prompt forbids pinyin in AI responses so the client can control annotation rendering and toggle visibility.

## Scripts

```sh
bun run dev        # Start dev server
bun run build      # Production build
bun run preview    # Preview production build
bun run typecheck  # svelte-check
```

## Run the home daemon (`vocab-home`)

The home daemon is a long-lived process you run on your own box. Bind a conversation to it, close the browser, and it keeps answering over sync. It is the same answer loop the browser runs (`attachChatWorker`), just hosted somewhere that does not go away when you shut a tab.

`apps/vocab` is itself an Epicenter root: `epicenter.config.ts` declares the mount and names the agent this daemon answers as (`vocab-home`). The `epicenter` binary and the daemon lifecycle (`epicenter daemon up`, `epicenter auth`, root discovery) are documented once in `packages/cli/README.md`; this section is the Vocab-specific wiring.

### One time: log the machine in

The daemon syncs and answers on your Epicenter account, so the machine needs a session.

```sh
epicenter auth login
```

This prints a URL. Sign in on the hosted portal, copy the one-time code from the success page, and paste it back into the terminal. The session is stored per API target under your platform user-data directory, so a local-dev login and a prod login coexist. Check it with `epicenter auth status`.

A signed-out machine is still a valid daemon: it serves the local mount, but a conversation that needs the metered account stays unanswered until you log in.

### Pick how the daemon answers

The daemon resolves one inference backend per mount, in priority order (ADR-0038):

1. **Local key (BYOK).** Set `GEMINI_API_KEY` (Vocab runs `gemini-3.5-flash`, a Gemini model). The daemon answers directly against Gemini with no cloud round-trip, billed to your key. This is the only backend that works offline or fully self-hosted, so it wins when present.
2. **Metered Epicenter account.** Set `VOCAB_USE_METERED=1`. The daemon answers over the same `/api/ai/chat` stream the browser uses, billed to your Epicenter credits. Opt-in only: a signed-in daemon never spends credits unless you ask it to, the same way BYOK needs a key.
3. **Neither.** The daemon hosts the conversation's sync but writes nothing. No placeholder, no half-answer; the turn waits for a configured answerer (a keyed daemon, or an open browser tab on your metered account). Starting a keyless, opt-out daemon is a supported state, not a misconfiguration: the doc is a durable mailbox.

### Start it

From the Vocab root (or pass `-C` to point at it):

```sh
GEMINI_API_KEY=... epicenter daemon up -C apps/vocab
# or, to answer on your metered Epicenter account:
VOCAB_USE_METERED=1 epicenter daemon up -C apps/vocab
```

The daemon runs in the foreground and prints sync and peer status to stderr. Backgrounding it is your job (a process manager, `nohup`, a systemd unit). It freezes its API target at boot; to retarget, `epicenter daemon down` then `epicenter daemon up` again.

### Bind a conversation to it

In the app, start a conversation with "Home daemon" as the agent ("New chat with → Home daemon"). The binding is set once at creation and never reassigned: to talk to a different agent you fork the conversation, so a transcript's history only ever reaches its one bound agent.

The daemon's observe loop hosts exactly the conversations bound to `vocab-home` (`row.agent === 'vocab-home'`, ADR-0025) and ignores the rest. Once bound, you can close the browser: the daemon answers ambiently over sync, and the next time a device opens that conversation it catches up on resync. Claiming the turn is existence-based (`findUnansweredTurn`): the assistant message keyed to the turn's `generationId` is the claim, so a watching browser tab and the daemon never answer one turn twice.

An unbound or offline daemon is fine. The picker lists "Home daemon" whether or not it is running, because the doc holds the turn until the daemon wakes. Nothing breaks if it is not home; the answer just waits.

## Manually verify the daemon

There is no automated end-to-end test for the cloud-plus-browser path, so this is the checklist to run by hand:

1. `epicenter auth login`, then `epicenter auth status` shows your account and a verified session.
2. Start the daemon with a backend, e.g. `GEMINI_API_KEY=... epicenter daemon up -C apps/vocab`. Confirm it prints `online (vocab)` and reaches `connected`.
3. In the app, create a conversation with "Home daemon" as the agent.
4. Send a turn. Confirm the assistant answer streams into the conversation, written by the daemon (the daemon's stderr shows activity; the browser made no HTTP kickoff for this conversation).
5. Send another turn and immediately close the browser tab mid-answer. Reopen the app and the same conversation: the answer is complete (or still streaming and then finishes), caught up on resync. Closing the tab did not stop the answer.
6. Stop the daemon (`Ctrl-C` or `epicenter daemon down -C apps/vocab`) and start it with no backend: unset `GEMINI_API_KEY` and leave `VOCAB_USE_METERED` off. It logs a warning that it has no inference backend and hosts sync without answering. Send a turn to a `vocab-home` conversation and confirm it stays unanswered. Restart with a backend and confirm the daemon then answers the waiting turn.
7. (Until the browser stops answering in a later wave) With a watching browser tab open and the daemon running, send a turn and confirm exactly one assistant answer appears, never two. Existence-is-the-claim is what prevents the double-answer.
