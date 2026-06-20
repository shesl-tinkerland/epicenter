# Zhongwen

Bilingual Chinese-English chat app for learning Mandarin. Users ask questions in English; the AI responds with mixed English and Chinese. The client automatically annotates Chinese characters with pinyin using `<ruby>` tags. The system prompt tells the AI to never include pinyin itself.

## How it works

**Chat over a synced doc (doc-as-wire)**: Each conversation's transcript lives in its own synced Yjs child doc, a `Y.Array('messages')` of append-only `Y.Map`s (one `Y.Text` of content per message). The client sends by appending a user message map (carrying a fresh `generationId`, the durable id of the assistant answer this turn awaits). An **in-process peer** then claims and answers that turn (ADR-0033): for a cloud-bound conversation the browser tab runs the answerer itself (`attachChatBrowserAnswerer`), sourcing tokens from the **Epicenter provider** (the metered `/api/ai/chat` SSE stream) and writing each delta straight into the same doc; for a daemon-bound conversation the always-on daemon worker (`attachChatWorker`) answers ambiently over sync. Either way the UI renders from a doc observer, so persistence, multi-device live view, and refresh-resume are consequences of one source of truth rather than separate features. Claiming is existence-based (`findUnansweredTurn`), so a tab and a daemon never answer one turn twice. Stop is a durable cancel written to the doc (`requestCancel`), so it works from any device. The cloud never writes the doc: it is a blind relay plus a stateless metered inference stream. The doc layout and the answerer are owned by `@epicenter/workspace/ai` (`chat-doc.ts`, `chat-browser-answerer.ts` / `chat-worker.ts`).

**Markdown + pinyin**: Assistant messages are parsed with `marked` (GFM, breaks enabled) into HTML, then `annotateHtml()` in `src/lib/pinyin/annotate.ts` walks text nodes (splitting on HTML tags via regex) and wraps CJK runs with `<ruby>` pinyin tags using `pinyin-pro`. Output is sanitized with DOMPurify (allowing ruby/rt/rp), memoized via `$derived` in `AssistantMessagePart.svelte`, and rendered via `{@html}` inside `<div class="prose prose-sm">`.

**Workspace state**: `zhongwenWorkspace` in `zhongwen.ts` is the shared isomorphic definition. It defines `epicenter-zhongwen`, the `conversations` table (the cheap list: title and timestamps), the `conversations.messages` child doc layout, the `showPinyin` KV value, and the Zhongwen model constant. Transcripts are not a table; they are per-conversation child docs opened as `zhongwen.tables.conversations.docs.messages.open(conversationId)`. `openZhongwenBrowser()` opens the definition with the signed-in browser connection, which attaches local storage, root collaboration, and the child-doc runtime.

```txt
defineWorkspace()
  -> zhongwenWorkspace
    -> openZhongwenBrowser() opens with a browser connection
    -> zhongwen() opens without a browser connection, then adds daemon infrastructure
```

**UI state**: split by lifetime. `src/routes/(signed-in)/+page.svelte` owns the page-local root-doc concerns: the conversation list (the `conversations` table), which conversation is active, and CRUD. The per-conversation runtime lives in `ConversationView.svelte`, mounted via `{#key activeConversationId}`, so the transcript doc gets a real component lifecycle (opened in setup, disposed in `onDestroy`). `ConversationView` opens the active conversation's `messages` child doc (IDB + websocket), renders messages from a doc observer, and derives liveness from update recency, never stored: a trailing assistant message with no `finish` and recent updates is streaming, the same message gone quiet past a ~3s grace window is interrupted (offer retry), and the terminal outcome is the message's write-once `finish` key.

**Auth**: Google OAuth through the shared Epicenter auth/session path. The browser runtime is built through `createSession`, so storage and sync only mount after a signed-in identity provides `ownerId` and WebSocket transport functions.

**Providers**: `@epicenter/constants/ai-providers` owns the shared servable model registry. `zhongwen.ts` owns Zhongwen's Gemini model.

## File map

```
src/
  lib/
    platform/auth/auth.ts  # OAuth auth client
    session.ts             # createSession + openZhongwenBrowser singleton
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
        ZhongwenSidebar.svelte   # Sidebar conversation list with create/switch/delete
zhongwen.ts                    # Shared isomorphic model (tables, KV, conversation child docs)
zhongwen.browser.ts            # openZhongwenBrowser runtime wiring
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
