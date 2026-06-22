/**
 * `@epicenter/workspace/agent`: the client-side agent loop (ADR-0047).
 *
 * One shape for every agent: the loop runs in the client, streams the live turn
 * into a snapshot the UI renders, reaches tools as dispatched actions through a
 * {@link ToolCatalog}, and persists only finished messages as last-write-wins
 * records. The capability-free case is the same loop with {@link NO_TOOLS}.
 */

export {
	createDispatchToolCatalog,
	type DispatchSurface,
	type DispatchToolCatalogOptions,
} from './dispatch-catalog.js';
export type {
	AgentEngine,
	AgentEngineRequest,
	EngineChunk,
} from './engine.js';
export {
	type ConversationError,
	type ConversationHandle,
	type ConversationOptions,
	type ConversationSnapshot,
	createConversation,
} from './loop.js';
export {
	type AgentMessage,
	type AgentMessagePart,
	type AgentMessageRole,
	type AgentTextPart,
	type AgentToolCallPart,
	type AgentToolResultPart,
	agentMessageText,
	isPersistableMessage,
	type ModelMessage,
	type ModelToolCall,
	toModelMessages,
} from './message.js';
export {
	type AgentToolCall,
	type AgentToolDefinition,
	type AgentToolOutcome,
	type Approval,
	type ApprovalDecision,
	defaultApprovalDecision,
	NO_TOOLS,
	type ToolCatalog,
} from './tools.js';
