# Zhongwen

Bilingual Chinese-English chat app for learning Mandarin. Users ask questions in English; the AI responds with mixed English and Chinese. The client automatically annotates Chinese characters with pinyin using `<ruby>` tags. The system prompt tells the AI to never include pinyin itself.

## How it works

**Chat streaming**: Each conversation gets a `ChatClient` (from `@tanstack/ai-client`) that streams SSE responses from `${APP_URLS.API}/ai/chat`. Provider, model, and system prompt are sent as request body data. The server uses TanStack AI's `chat()` with the requested provider adapter. Messages come back as `UIMessage` objects with `TextPart`s.

**Markdown + pinyin**: Assistant messages are parsed with `marked` (GFM, breaks enabled) into HTML, then `annotateHtml()` in `src/lib/pinyin/annotate.ts` walks text nodes (splitting on HTML tags via regex) and wraps CJK runs with `<ruby>` pinyin tags using `pinyin-pro`. Output is sanitized with DOMPurify (allowing ruby/rt/rp), memoized via `$derived` in `AssistantMessagePart.svelte`, and rendered via `{@html}` inside `<div class="prose prose-sm">`.

**Workspace state**: `createZhongwenWorkspace()` in `workspace.ts` is the shared isomorphic model. It defines `epicenter.zhongwen`, the `conversations` and `chatMessages` tables, the `showPinyin` KV value, and the app action registry. `openZhongwenBrowser()` attaches encrypted local storage and collaboration around that model. `zhongwen()` returns the project mount that attaches daemon persistence and sync around the same model.

```txt
createWorkspace()
  -> createZhongwenWorkspace()
    -> openZhongwenBrowser()
    -> zhongwen() (project mount)
```

**UI state**: `createChatState()` in `src/routes/(signed-in)/chat/chat-state.svelte.ts` is a Svelte 5 factory for the live chat UI. It bridges workspace-backed conversations with the streaming `ChatClient` handles used while a model response is in flight.

**Auth**: Google OAuth through the shared Epicenter auth/session path. The browser runtime is built through `createSession`, so storage and sync only mount after a signed-in identity provides `ownerId`, `keyring`, and WebSocket transport functions.

**Providers**: `src/lib/chat/providers.ts` maps provider names to model lists imported from `@tanstack/ai-{openai,anthropic,gemini,grok}`. Default is OpenAI. Provider/model is per-conversation and configurable in the UI.

## File map

```
src/
  routes/
    (signed-in)/+page.svelte          # Main layout: sidebar + chat area + pinyin toggle
    +layout.svelte         # Root layout with Toaster
    +layout.ts             # SSR disabled (CSR only)
  lib/
    platform/auth/auth.ts  # OAuth auth client
    session.ts             # createSession + openZhongwenBrowser singleton
    pinyin/
      annotate.ts          # annotateHtml(): CJK detection and ruby annotation
  routes/(signed-in)/
    chat/
      chat-state.svelte.ts # Reactive multi-conversation state
      providers.ts         # Provider/model config from TanStack AI packages
      system-prompt.ts     # AI instructions (mix languages, no pinyin, simplified only)
    components/
      ChatMessage.svelte       # Renders UIMessage; delegates assistant parts to AssistantMessagePart
      AssistantMessagePart.svelte # Markdown parse + pinyin annotate + DOMPurify, memoized via $derived
      ChatInput.svelte         # Textarea + send button, Enter to submit
      ZhongwenSidebar.svelte   # Sidebar conversation list with create/switch
    zhongwen/
      browser.ts               # openZhongwenBrowser runtime wiring
```

## Key decisions

- Conversations and messages are persisted in the Zhongwen workspace.
- SSR is disabled; the app is CSR-only.
- The system prompt forbids pinyin in AI responses so the client can control annotation rendering and toggle visibility.
- Zhongwen has no child docs and no daemon actions today; the root Y.Doc is the whole workspace surface.

## Scripts

```sh
bun run dev        # Start dev server
bun run build      # Production build
bun run preview    # Preview production build
bun run typecheck  # svelte-check
```
