/**
 * The client-side agent loop (ADR-0047): one shape for every agent, run in the
 * client, in memory. It streams the live turn into a snapshot the UI renders,
 * drives the multi-step model/tool dance, and persists only finished messages
 * as last-write-wins records. The daemon never runs this loop; tools reach it as
 * dispatched actions through the injected {@link ToolCatalog}.
 *
 * This is the framework-agnostic core. A Svelte binding mirrors its
 * {@link ConversationSnapshot} into reactive state; the loop itself is plain
 * TypeScript so the turn machine is testable without a UI.
 *
 * One model call is one step. A step streams text and tool-call requests into a
 * fresh assistant message; if it asked for tools, the loop runs them (gated by
 * approval), appends their results, and re-prompts with the augmented
 * transcript; it repeats until a step finishes with no tool calls. The
 * zero-tool case (Vocab) is one step that only ever produces text.
 */
import { extractErrorMessage } from 'wellcrafted/error';
import type { JsonValue } from 'wellcrafted/json';
import type { KvStoreHandle } from '../document/attach-kv-store.js';
import type { AgentEngine } from './engine.js';
import {
	type AgentMessage,
	isPersistableMessage,
	toModelMessages,
} from './message.js';
import {
	type AgentToolCall,
	type Approval,
	defaultApprovalDecision,
	NO_TOOLS,
	type ToolCatalog,
} from './tools.js';

/**
 * A failed turn: a human-readable message plus an optional structured code (e.g.
 * `'InsufficientCredits'`, `'Unauthorized'`) the engine surfaced on its
 * `run-error` chunk, so the UI can branch on the code rather than match the
 * message string.
 */
export type ConversationError = { message: string; code?: string };

/** The render state of one conversation: durable transcript plus the live turn. */
export type ConversationSnapshot = {
	/** Persisted messages plus the in-flight turn once it has visible content. */
	messages: AgentMessage[];
	/** A turn is claimed but nothing visible has streamed yet (typing bubble). */
	isThinking: boolean;
	/** A turn is in flight (disable input, offer stop). */
	isGenerating: boolean;
	/** The last turn's failure, or null. Cleared on the next turn. */
	error: ConversationError | null;
};

/** The framework-agnostic conversation handle the UI binds to. */
export type ConversationHandle = {
	snapshot(): ConversationSnapshot;
	/** Register a change listener; returns the remover. Fires on every change. */
	subscribe(listener: () => void): () => void;
	/** Persist the user turn and answer it. No-op on empty input or mid-turn. */
	send(content: string): void;
	/** Abort the in-flight turn; its partial messages are dropped. */
	stop(): void;
	/** Re-answer the latest user turn after a failure. */
	retry(): void;
	[Symbol.dispose](): void;
};

export type ConversationOptions = {
	/** The opened `conversations.messages` store, keyed by message id. */
	store: KvStoreHandle<AgentMessage> & Disposable;
	/** The inference backend (the metered Epicenter stream, BYOK, or local). */
	engine: AgentEngine;
	/** The live tool surface; omit for a capability-free agent. */
	tools?: ToolCatalog;
	/** The approval policy and prompt; omit to deny every gated mutation. */
	approval?: Approval;
	/** Mint a message id. */
	generateId: () => string;
	/** Clock, injectable for tests. */
	now?: () => number;
};

/** When no approval is wired, a gated mutation is denied rather than run. */
const DENY_GATED_MUTATIONS: Approval = {
	decide: defaultApprovalDecision,
	request: async () => false,
};

export function createConversation(
	options: ConversationOptions,
): ConversationHandle {
	const {
		store,
		engine,
		tools = NO_TOOLS,
		approval = DENY_GATED_MUTATIONS,
		generateId,
		now = Date.now,
	} = options;

	const listeners = new Set<() => void>();
	function notify(): void {
		for (const listener of listeners) listener();
	}

	/**
	 * The durable transcript, chronologically ordered. It is a flat, linear list
	 * by design: branching and edit history are a product tier built above the
	 * loop, not a missing primitive (ADR-0047 considered and deferred them, as
	 * TanStack's own flat `UIMessage[]` does). Deferred indefinitely.
	 */
	function readAll(): AgentMessage[] {
		return [...store.entries()]
			.map((entry) => entry.val)
			.sort((a, b) => a.createdAt - b.createdAt);
	}

	let persisted = readAll();
	const unobserve = store.observe(() => {
		persisted = readAll();
		notify();
	});

	// The in-flight turn: assistant messages built this turn, component-only
	// until a clean finish persists them. Null between turns.
	let turn: AgentMessage[] | null = null;
	let error: ConversationError | null = null;
	let controller: AbortController | null = null;

	function snapshot(): ConversationSnapshot {
		// One predicate decides both what renders live and what persists: a
		// message the UI shows mid-turn is exactly a message a clean finish
		// keeps. They must not drift, or a message would render then vanish on
		// finish. `parts.length > 0` happens to agree today only because
		// `appendText` never opens an empty text part; a future non-persistable
		// part type (a reasoning marker, say) would break that. Sharing
		// `isPersistableMessage` keeps the two in lockstep by construction.
		const live = (turn ?? []).filter(isPersistableMessage);
		return {
			messages: live.length > 0 ? [...persisted, ...live] : persisted,
			isThinking: turn !== null && live.length === 0,
			isGenerating: turn !== null,
			error,
		};
	}

	/** Stream one model call into `assistant`, returning the calls it requested. */
	async function runStep(
		assistant: AgentMessage,
		signal: AbortSignal,
	): Promise<{ calls: AgentToolCall[]; failure?: ConversationError }> {
		const prompt = toModelMessages([...persisted, ...(turn ?? [])]);
		const calls: AgentToolCall[] = [];
		let failure: ConversationError | undefined;

		try {
			for await (const chunk of engine(
				{ messages: prompt, tools: tools.definitions() },
				signal,
			)) {
				if (signal.aborted) break;
				switch (chunk.type) {
					case 'text-delta':
						appendText(assistant, chunk.delta);
						notify();
						break;
					case 'tool-call': {
						const call: AgentToolCall = {
							toolCallId: chunk.toolCallId,
							toolName: chunk.toolName,
							input: chunk.input,
						};
						calls.push(call);
						assistant.parts.push({ type: 'tool-call', ...call });
						notify();
						break;
					}
					case 'run-error':
						failure = {
							message: chunk.message,
							...(chunk.code !== undefined && { code: chunk.code }),
						};
						break;
					default:
						break;
				}
			}
		} catch (cause) {
			if (!signal.aborted) failure = { message: extractErrorMessage(cause) };
		}

		return { calls, failure };
	}

	/** Run a step's tool calls, gated by approval, appending each result. */
	async function runTools(
		assistant: AgentMessage,
		calls: AgentToolCall[],
		signal: AbortSignal,
	): Promise<void> {
		const definitions = new Map(
			tools.definitions().map((definition) => [definition.name, definition]),
		);
		for (const call of calls) {
			if (signal.aborted) return;
			const definition = definitions.get(call.toolName);
			const decision = definition ? approval.decide(call, definition) : 'auto';

			if (decision === 'deny') {
				appendToolResult(assistant, call, 'Denied by policy.', true);
				notify();
				continue;
			}
			if (decision === 'ask' && definition) {
				const approved = await approval.request(call, definition);
				if (signal.aborted) return;
				if (!approved) {
					appendToolResult(assistant, call, 'Denied by the user.', true);
					notify();
					continue;
				}
			}

			const outcome = await tools.resolve(call, signal);
			if (signal.aborted) return;
			appendToolResult(assistant, call, outcome.output, outcome.isError);
			notify();
		}
	}

	async function runTurn(): Promise<void> {
		controller = new AbortController();
		const { signal } = controller;
		error = null;
		turn = [];
		notify();

		let failure: ConversationError | undefined;
		while (!signal.aborted) {
			const assistant: AgentMessage = {
				id: generateId(),
				role: 'assistant',
				createdAt: now(),
				parts: [],
			};
			turn.push(assistant);
			notify();

			const step = await runStep(assistant, signal);
			if (signal.aborted) break;
			if (step.failure !== undefined) {
				failure = step.failure;
				break;
			}
			if (step.calls.length === 0) break; // a text finish ends the turn

			await runTools(assistant, step.calls, signal);
		}

		const aborted = signal.aborted;
		const finished =
			!aborted && failure === undefined && turn
				? turn.filter(isPersistableMessage)
				: [];

		// Clear the live turn before persisting so the durable messages never
		// double-render: once `turn` is null, the store write refreshes
		// `persisted` to include them.
		turn = null;
		controller = null;
		error = failure ?? null;
		for (const message of finished) store.set(message.id, message);
		notify();
	}

	return {
		snapshot,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		send(content) {
			const text = content.trim();
			if (!text || turn !== null) return;
			const id = generateId();
			store.set(id, {
				id,
				role: 'user',
				createdAt: now(),
				parts: [{ type: 'text', text }],
			});
			void runTurn();
		},
		stop() {
			controller?.abort();
		},
		retry() {
			if (turn !== null) return;
			void runTurn();
		},
		[Symbol.dispose]() {
			controller?.abort();
			unobserve();
			store[Symbol.dispose]();
		},
	};
}

/** Append a text delta to the trailing text part, opening one if needed. */
function appendText(message: AgentMessage, delta: string): void {
	if (!delta) return;
	const last = message.parts[message.parts.length - 1];
	if (last?.type === 'text') last.text += delta;
	else message.parts.push({ type: 'text', text: delta });
}

function appendToolResult(
	message: AgentMessage,
	call: AgentToolCall,
	output: JsonValue,
	isError: boolean,
): void {
	message.parts.push({
		type: 'tool-result',
		toolCallId: call.toolCallId,
		toolName: call.toolName,
		output,
		isError,
	});
}
