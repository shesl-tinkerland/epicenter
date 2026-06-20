---
name: tanstack-ai
description: TanStack AI patterns for @tanstack/ai, @tanstack/ai-svelte, chat state, streamed responses, UIMessage parts, tool calling, tool approvals, and provider model adapters. Use when working on AI chat, createChat, fetchServerSentEvents, UIMessage conversion, or TanStack AI tools.
metadata:
  author: epicenter
  version: '1.0'
---

# TanStack AI

## Reference Repositories

- [TanStack AI](https://github.com/tanstack/ai) - Framework and adapters for AI chat, streaming, tools, and provider integrations

## Upstream Grounding

When TanStack AI behavior, `createChat`, streamed message parts, tool calling, approvals, provider adapters, or Svelte bindings affect correctness, ask DeepWiki a narrow question against `TanStack/ai` before relying on memory. Use it to orient, then verify decisive details against local installed types, source, or official docs before changing code.

Skip DeepWiki for repo-local chat persistence and UI patterns already visible in the app.

## When to Apply This Skill

Use this pattern when you need to:

- Build or refactor chat state based on `createChat`.
- Convert persisted workspace messages to or from TanStack AI `UIMessage` values.
- Render `MessagePart`, tool-call, or tool-result parts.
- Bridge workspace actions into TanStack AI tools.
- Debug streamed responses, reload behavior, stop behavior, or tool approvals.

## Package Boundaries

- Server activity functions live in `@tanstack/ai`: `chat`, generation helpers, stream conversion, model-message conversion, and server tool definitions.
- Client lifecycle lives in `@tanstack/ai-client`: chat client state, stream processing, tool approval plumbing, and client tool results.
- Svelte runes integration lives in `@tanstack/ai-svelte`: `createChat`, `fetchServerSentEvents`, and Svelte-friendly reactive state.
- Import provider adapters from their specific packages for tree shaking, such as `@tanstack/ai-openai` or `@tanstack/ai-anthropic`.

## Streaming And Tool Calls

- Prefer `toServerSentEventsResponse` on the server and `fetchServerSentEvents` on the client for chat streams.
- Treat AG-UI stream chunks and `MessagePart` variants as a discriminated stream protocol. Render every known part deliberately and keep an unknown fallback for forward compatibility.
- Use `StreamProcessor` when replaying, debugging, or transforming stream chunks outside the normal chat client.
- Approval flow uses the approval id. Do not assume it is the same as the tool call id.
- After a client tool produces a result, continue the chat through the TanStack AI client path instead of manually appending a fake assistant response.
- In Svelte components that own a chat instance, call `chat.stop()` or dispose the owner on unmount when a stream may still be active.
- Use `aiEventClient` observability events when diagnosing stream, adapter, or tool behavior.

## Local Anchors

- `apps/tab-manager/src/lib/chat/chat-state.svelte.ts` shows Svelte chat state, streaming, and tool approval handling, with the conversation list derived from the handle registry.
- `apps/tab-manager/src/lib/chat/persistence.ts` owns the device-local IndexedDB chat store behind `ChatClientPersistence`.
- `apps/opensidian/src/lib/chat/ui-message.ts` shows the persisted-message to TanStack-message boundary for workspace-backed chat history.
- `packages/workspace/src/ai/tool-bridge.ts` converts workspace actions into client tools and serializable server tool definitions.
