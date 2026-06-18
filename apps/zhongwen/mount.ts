/**
 * Zhongwen mount.
 *
 * `zhongwen()` returns the `Mount` that an `epicenter.config.ts`
 * default-exports. Zhongwen has no daemon actions to add and no materializers,
 * so the daemon hosts the root Y.Doc on disk and bridges cloud sync, then runs
 * one child-doc actor: an always-on observe loop (ADR-0014/0015) over the
 * `conversations.messages` transcripts. Registering the field is all the app
 * declares; the table, the guid, and the layout come from the schema. The
 * factory is the behavior seam, and it hands each hosted transcript to
 * `attachChatActor`, the backend-agnostic append loop in
 * `@epicenter/workspace/ai`.
 *
 * The actor is parameterized by a `ChatStream`
 * (`startStream(messages, signal) => AsyncIterable<StreamChunk>`), the one
 * contract every inference backend speaks. The daemon builds the real one from
 * the same `chat()` call the hosted route makes ({@link resolveChatStream}): a
 * Gemini adapter keyed on `GEMINI_API_KEY`, under the shared
 * `ZHONGWEN_SYSTEM_PROMPT`. With no key it falls back to {@link fakeChatStream},
 * a deterministic placeholder, and says so in the log: that fallback is the
 * explicit "real inference not wired on this host yet" boundary. The actor
 * itself observes -> answers -> streams -> finishes and honors the client's
 * durable cancel, all over hosted sync with no HTTP and no duplicate stream.
 *
 * Designation (R, ADR-0015) is the observe loop's concern, not this factory's:
 * the loop builds an actor only for conversations bound to this daemon's agent
 * (`row.agent === selfAgentId`), so the factory supplies behavior alone. The
 * `agentId` option names which catalog agent this daemon answers as (a
 * `ZHONGWEN_AGENTS` id like `zhongwen-home`); omit it and the daemon hosts
 * nothing, leaving every conversation to its bound agent. The browser nudges the
 * HTTP route only for cloud-runtime conversations, so a single turn is never
 * answered twice.
 */

import type { AgentId } from '@epicenter/workspace';
import { attachChatActor, type ChatStream } from '@epicenter/workspace/ai';
import { nodeMountRuntime } from '@epicenter/workspace/node';
import {
	chat,
	EventType,
	type ModelMessage,
	type StreamChunk,
} from '@tanstack/ai';
import { createGeminiChat } from '@tanstack/ai-gemini';
import { createLogger } from 'wellcrafted/logger';
import {
	ZHONGWEN_MODEL,
	ZHONGWEN_SYSTEM_PROMPT,
	zhongwenWorkspace,
} from './zhongwen.js';

const log = createLogger('zhongwen/mount');

export type ZhongwenMountOptions = {
	/**
	 * Base URL of the Epicenter cloud API used for sync.
	 * Defaults to `process.env.EPICENTER_API_URL`, falling back to the hosted API.
	 */
	baseURL?: string;
	/**
	 * The catalog agent this daemon answers as (ADR-0015): a `ZHONGWEN_AGENTS` id
	 * such as `zhongwen-home`. The observe loop then hosts exactly the
	 * conversations bound to it. Omit it and the daemon hosts nothing.
	 */
	agentId?: AgentId;
};

export function zhongwen({ baseURL, agentId }: ZhongwenMountOptions = {}) {
	// Resolve the inference backend once: the adapter is built a single time and
	// the closure is shared across every hosted transcript.
	const startStream = resolveChatStream();
	return zhongwenWorkspace.mount({
		baseURL,
		agentId,
		runtime: nodeMountRuntime(),
		actors: {
			conversations: {
				messages: ({ ydoc }) => attachChatActor({ ydoc, startStream }),
			},
		},
	});
}

/**
 * The daemon's inference backend as a {@link ChatStream}. With `GEMINI_API_KEY`
 * set, this is real inference: a Gemini adapter (built once) driven by the same
 * `chat()` call the hosted route makes, under {@link ZHONGWEN_SYSTEM_PROMPT}. The
 * actor hands a `signal`; `chat()` cancels on an `AbortController`, so the signal
 * is forwarded onto one. With no key it returns the deterministic placeholder and
 * logs that real inference is not live on this host.
 */
function resolveChatStream(): ChatStream {
	const apiKey = process.env.GEMINI_API_KEY;
	if (!apiKey) {
		log.warn(
			new Error(
				'GEMINI_API_KEY is not set; the Zhongwen daemon answers with the placeholder stream (real inference is not live on this host).',
			),
		);
		return fakeChatStream;
	}
	const adapter = createGeminiChat(ZHONGWEN_MODEL, apiKey);
	return (messages, signal) => {
		const abortController = new AbortController();
		if (signal.aborted) abortController.abort();
		else
			signal.addEventListener('abort', () => abortController.abort(), {
				once: true,
			});
		return chat({
			adapter,
			messages,
			systemPrompts: [ZHONGWEN_SYSTEM_PROMPT],
			abortController,
		});
	};
}

/**
 * A deterministic placeholder {@link ChatStream}: stream a fixed reply one
 * text-delta per word so the claim -> stream -> finish path is exercised end to
 * end without a provider. Used when the daemon has no provider key; real
 * inference is the same contract, so swapping it changes nothing downstream.
 */
const fakeChatStream: ChatStream = async function* (
	messages: ModelMessage[],
): AsyncGenerator<StreamChunk> {
	const userText = String(messages.at(-1)?.content ?? '');
	const reply = `Received: "${userText.trim()}". This is a placeholder reply streamed by the always-on actor; set GEMINI_API_KEY for real inference.`;
	for (const token of reply.match(/\S+\s*/g) ?? [reply]) {
		yield {
			type: EventType.TEXT_MESSAGE_CONTENT,
			messageId: 'fake',
			delta: token,
		} as StreamChunk;
		// Yield between tokens so each append is its own synced transaction and a
		// teardown or cancel abort can land between them.
		await Promise.resolve();
	}
};
