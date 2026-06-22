# Vocab

Bilingual Chinese-English chat app for learning Mandarin. Users ask questions in English; the AI responds with mixed English and Chinese. The client automatically annotates Chinese characters with pinyin using `<ruby>` tags. The system prompt tells the AI to never include pinyin itself.

## How it works

**Live answer in state, finished messages in the doc**: Vocab is capability-free (ADR-0043), so the open browser tab answers its own turns, and the live answer needs nothing durable (re-asking is free). A turn streams from the **Epicenter provider** (the metered `/api/ai/chat` SSE stream) straight into Svelte `$state` in `src/lib/conversation.svelte.ts`, never into the synced doc. Only finished messages persist (ADR-0046): the user turn the moment it is sent, the assistant turn on a clean finish, each written once as one JSON blob into the conversation's last-write-wins message store (`attachKvStore`, keyed by message id). A stopped or failed turn writes nothing; the durable user turn stays, ready to retry. On open, the controller hydrates from the store and observes it, so a message finished on another device shows up here.

**Markdown + pinyin**: Assistant messages are parsed with `marked` (GFM, breaks enabled) into HTML, then `annotateHtml()` in `src/lib/pinyin/annotate.ts` walks text nodes (splitting on HTML tags via regex) and wraps CJK runs with `<ruby>` pinyin tags using `pinyin-pro`. Output is sanitized with DOMPurify (allowing ruby/rt/rp), memoized via `$derived` in `AssistantMessagePart.svelte`, and rendered via `{@html}` inside `<div class="prose prose-sm">`.

**Workspace state**: `vocabWorkspace` in `vocab.ts` is the shared isomorphic definition. It defines `epicenter-vocab`, the `conversations` table (the cheap list: title and timestamps), the `conversations.messages` child doc as a per-id LWW message store (`attachKvStore<VocabMessage>`), the `showPinyin` KV value, the Vocab model constant, and the `VocabMessage` shape. Transcripts are not a table; they are per-conversation child docs opened as `vocab.tables.conversations.docs.messages.open(conversationId)`. `openVocabBrowser()` opens the definition with the signed-in browser connection, which attaches local storage, root collaboration, and the child-doc runtime.

```txt
defineWorkspace()
  -> vocabWorkspace
    -> openVocabBrowser() opens with a browser connection
```

**UI state**: split by lifetime. `src/routes/(signed-in)/+page.svelte` owns the page-local root-doc concerns: the conversation list (the `conversations` table), which conversation is active, and CRUD. The per-conversation runtime lives in `ConversationView.svelte`, mounted via `{#key activeConversationId}`, so each conversation gets a real component lifecycle (opened in setup, disposed in `onDestroy`). `ConversationView` opens the active conversation's `messages` store and hands it to `createConversation` (`src/lib/conversation.svelte.ts`), which streams the live turn into `$state`, persists finished messages, and exposes `messages` / `isThinking` / `isGenerating` / `error` plus `send` / `stop` / `retry`.

**Auth**: Google OAuth through the shared Epicenter auth/session path. The browser runtime is built through `createSession`, so storage and sync only mount after a signed-in identity provides `ownerId` and WebSocket transport functions.

**Providers**: `@epicenter/constants/ai-providers` owns the shared servable model registry. `vocab.ts` owns Vocab's Gemini model.

## File map

```
src/
  lib/
    platform/auth/auth.ts  # OAuth auth client
    session.ts             # createSession + openVocabBrowser singleton
    conversation.svelte.ts # createConversation: $state streaming + LWW persistence
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
        ConversationView.svelte  # Keyed per-conversation view; binds the message store to the inference stream
        ChatMessage.svelte       # Renders one VocabMessage (user text, or assistant markdown via AssistantMessagePart)
        AssistantMessagePart.svelte # Markdown parse + pinyin annotate + DOMPurify, memoized via $derived
        ChatInput.svelte         # Textarea + send button, Enter to submit
        VocabSidebar.svelte   # Sidebar conversation list with create/switch/delete
vocab.ts                    # Shared isomorphic model (tables, KV, VocabMessage shape, conversation child docs)
vocab.browser.ts            # openVocabBrowser runtime wiring
```

## Key decisions

- The conversation list lives in the root workspace doc (`conversations` table); each transcript lives in its own synced child doc, a per-id LWW message store. There is no `chatMessages` table.
- The live answer streams in component `$state`, not the synced doc (ADR-0046): vocab is capability-free, so re-asking is free and only finished messages need to sync. Each finished message is one LWW JSON blob keyed by message id, written the moment a normal app would POST the row.
- The cloud never writes the doc: it is a blind relay plus a stateless metered inference stream (ADR-0033).
- SSR is disabled; the app is CSR-only.
- The system prompt forbids pinyin in AI responses so the client can control annotation rendering and toggle visibility.

## Scripts

```sh
bun run dev        # Start dev server
bun run build      # Production build
bun run preview    # Preview production build
bun run typecheck  # svelte-check
```
