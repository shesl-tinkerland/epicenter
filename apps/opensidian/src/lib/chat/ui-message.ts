/**
 * Render boundary: a synced conversation-doc message on one side, TanStack AI's
 * `UIMessage` on the other.
 *
 * Since the render-from-doc migration, chat history is not a `chatMessages` table
 * read into `createChat`; it is the conversation transcript child doc
 * (`attachChatTranscript`), snapshotted as `ChatDocMessage[]`. The chat
 * components still speak TanStack AI's `UIMessage` / `MessagePart` at runtime, so
 * this one file converts a doc snapshot into a `UIMessage`. Keeping it here makes
 * drift loud: if either side changes shape, TypeScript fails here.
 */

import type { ChatDocMessage } from '@epicenter/workspace/ai';
import type { UIMessage } from '@tanstack/ai-svelte';

// Derive the part type from UIMessage so the cast guards the union the UI
// actually consumes (@tanstack/ai-client's MessagePart).
type UiMessagePart = UIMessage['parts'][number];

type Expect<T extends true> = T;
type Equal<TLeft, TRight> =
	(<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2
		? true
		: false;

type ExpectedPartTypes =
	| 'text'
	| 'image'
	| 'audio'
	| 'video'
	| 'document'
	| 'tool-call'
	| 'tool-result'
	| 'thinking'
	| 'structured-output';

type _PartTypeDriftCheck = Expect<
	Equal<UiMessagePart['type'], ExpectedPartTypes>
>;

/**
 * Convert one transcript-doc message snapshot into TanStack AI's runtime message.
 *
 * The doc's body parts (`ChatDocPart`: text today; tool-call / tool-result once
 * Phase B lands) are the persisted subset of `MessagePart`, structurally
 * compatible with the render union, so this is a cast over a re-keyed envelope
 * (`createdAt` becomes a `Date`). It is the single place a doc snapshot becomes a
 * `UIMessage`.
 */
export function chatDocMessageToUiMessage(message: ChatDocMessage): UIMessage {
	return {
		id: message.id,
		role: message.role,
		parts: message.parts as unknown as UiMessagePart[],
		createdAt: new Date(message.createdAt),
	};
}
