/**
 * The loop's view of its tools, kept tool-agnostic: the loop knows how to offer
 * tools to the model and how to run one, never where a tool lives. Wave 2 fills
 * a {@link ToolCatalog} from the live presence manifest and dispatches `resolve`
 * to the peer that owns the action (ADR-0047); the loop does not change.
 */
import type { JsonValue } from 'wellcrafted/json';

/**
 * What the model is told about one tool. `kind` drives approval (a query runs
 * unattended; a mutation is gated, ADR-0044). The engine forwards
 * `{ name, description, inputSchema }` to the provider; the action key is the
 * tool name verbatim.
 */
export type AgentToolDefinition = {
	name: string;
	title?: string;
	description?: string;
	inputSchema?: JsonValue;
	kind: 'query' | 'mutation';
};

/** One tool call the model asked for, with its parsed input. */
export type AgentToolCall = {
	toolCallId: string;
	toolName: string;
	input: JsonValue;
};

/** The outcome of running a tool: a JSON value, flagged when it is an error. */
export type AgentToolOutcome = { output: JsonValue; isError: boolean };

/**
 * The tool surface the loop is handed. `definitions` is the live catalog the
 * model sees each step; `resolve` runs one call and returns its outcome. A loop
 * with no tools (Vocab) gets {@link NO_TOOLS}.
 */
export type ToolCatalog = {
	definitions(): AgentToolDefinition[];
	resolve(call: AgentToolCall, signal: AbortSignal): Promise<AgentToolOutcome>;
};

/** The empty catalog: a capability-free agent offers and runs no tools. */
export const NO_TOOLS: ToolCatalog = {
	definitions: () => [],
	resolve: async (call) => ({
		output: `No tool named ${call.toolName} is available.`,
		isError: true,
	}),
};

/** Per-conversation approval policy (ADR-0044), resolved per call. */
export type ApprovalDecision = 'auto' | 'ask' | 'deny';

/**
 * Decide and, when needed, obtain approval for one call. `decide` is the
 * per-conversation policy; `request` is the synchronous in-client prompt the
 * loop awaits for an `ask` (ADR-0047: the human is present, so the loop pauses
 * rather than writing a durable approval record). `request` resolves to whether
 * the call was approved.
 */
export type Approval = {
	decide(
		call: AgentToolCall,
		definition: AgentToolDefinition,
	): ApprovalDecision;
	request(
		call: AgentToolCall,
		definition: AgentToolDefinition,
	): Promise<boolean>;
};

/**
 * The default policy: a query runs unattended, a mutation is asked. Used when a
 * conversation declares no explicit policy.
 */
export function defaultApprovalDecision(
	_call: AgentToolCall,
	definition: AgentToolDefinition,
): ApprovalDecision {
	return definition.kind === 'mutation' ? 'ask' : 'auto';
}
