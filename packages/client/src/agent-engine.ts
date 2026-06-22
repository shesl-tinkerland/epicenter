/**
 * The client side of the inference-engine seam (ADR-0049/0050). These are
 * structural twins of `@epicenter/workspace/agent`'s engine contract
 * (`AgentEngine`, `AgentEngineRequest`, `EngineChunk`, the prompt message
 * shapes), redefined here so an engine built in this package drops into the
 * workspace loop without the client depending on the workspace core.
 *
 * The OpenAI-compatible engine (`openai-provider.ts`) builds an
 * {@link AgentEngine} that emits {@link EngineChunk}s; the loop only ever sees
 * this vocabulary, so swapping the inference backend is the engine's concern,
 * never the loop's.
 */
import type { JsonValue } from 'wellcrafted/json';

/**
 * The fetch an engine calls: a function from a URL plus init to a response.
 * Structurally `@epicenter/auth`'s `AuthFetch` and a plain `globalThis.fetch`,
 * but typed as the function shape rather than `typeof globalThis.fetch` because
 * the engine never needs `fetch.preconnect`, and an authed fetch wrapper (which
 * is what the gateway path passes) does not carry it.
 */
export type EngineFetch = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

/**
 * One tool call in a prompt transcript, in the OpenAI/TanStack function-call
 * shape. The OpenAI-compatible engine maps this to a `tool_calls[]` entry; the
 * legacy engine forwards it verbatim.
 */
export type ModelToolCall = {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
};

/**
 * A frozen transcript message: the structural twin of the workspace loop's
 * prompt message. A `user`/`assistant` message carries prose `content`; an
 * `assistant` message may carry `toolCalls`; a `tool` message carries one tool
 * result keyed by `toolCallId`.
 */
export type ModelMessage = {
	role: 'user' | 'assistant' | 'tool';
	content: string;
	name?: string;
	toolCalls?: ModelToolCall[];
	toolCallId?: string;
};

/**
 * One streamed event from an engine: the structural twin of the loop's
 * {@link EngineChunk}. A prose delta, one completed tool call (the engine
 * accumulates a provider's streamed deltas and emits one finished call with
 * parsed input), or a turn-ending failure.
 */
export type EngineChunk =
	| { type: 'text-delta'; delta: string }
	| {
			type: 'tool-call';
			toolCallId: string;
			toolName: string;
			input: JsonValue;
	  }
	| { type: 'run-error'; message: string; code?: string };

/**
 * One tool offered to the model, the subset the wire needs. Structurally the
 * loop's `AgentToolDefinition`, inlined so the client stays decoupled from the
 * workspace core. `kind` and `title` are loop concerns; the wire needs only the
 * name, description, and input schema.
 */
export type AgentEngineToolDefinition = {
	name: string;
	description?: string;
	inputSchema?: unknown;
};

/**
 * Structurally the loop's `AgentEngineRequest`: the snapshotted prompt plus the
 * live tool catalog for this step.
 */
export type AgentEngineRequest = {
	messages: ModelMessage[];
	tools: AgentEngineToolDefinition[];
};

/**
 * Structurally the loop's `AgentEngine` (`@epicenter/workspace/agent`): one
 * model call, a request in, a stream of {@link EngineChunk}s out.
 */
export type AgentEngine = (
	request: AgentEngineRequest,
	signal: AbortSignal,
) => AsyncIterable<EngineChunk>;
