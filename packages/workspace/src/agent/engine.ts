/**
 * The inference-engine seam (ADR-0049/0050): the small, framework-agnostic
 * contract the client agent loop drives. An engine turns one snapshotted prompt
 * plus a tool catalog into a stream of {@link EngineChunk}s; the loop reduces
 * those chunks into messages and runs the tools it asked for.
 *
 * This vocabulary is the loop's own, not a vendor SDK's. An OpenAI-compatible
 * engine parses OpenAI SSE deltas into these chunks, so the loop only ever sees
 * an {@link EngineChunk} and swapping the inference backend is the engine's
 * concern, never the loop's.
 */
import type { JsonValue } from 'wellcrafted/json';
import type { ModelMessage } from './message.js';
import type { AgentToolDefinition } from './tools.js';

/**
 * One streamed event from an engine: a prose delta, one completed tool call the
 * model asked for, or a turn-ending failure. The engine owns provider quirks: it
 * accumulates a provider's streamed (and possibly fragmented or index-less)
 * tool-call deltas and emits one finished `tool-call` with parsed input, so the
 * loop never reduces partial arguments itself. A turn ends when the stream
 * completes with no tool calls collected; the loop never reads a provider finish
 * reason (some providers send `finish_reason: "stop"` mid-tool-call).
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

/** What the loop asks the model on one step: the prompt plus the live tools. */
export type AgentEngineRequest = {
	messages: ModelMessage[];
	tools: AgentToolDefinition[];
};

/**
 * One model call: a snapshotted prompt and the available tools in, a stream of
 * {@link EngineChunk}s out. It runs one model invocation and never executes a
 * tool or reads the store (ADR-0033's pure token source). The Epicenter metered
 * stream, a self-hosted gateway, and a local model all satisfy it.
 */
export type AgentEngine = (
	request: AgentEngineRequest,
	signal: AbortSignal,
) => AsyncIterable<EngineChunk>;
