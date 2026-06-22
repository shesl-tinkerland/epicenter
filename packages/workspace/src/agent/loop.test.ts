import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { attachKvStore } from '../document/attach-kv-store.js';
import type { AgentEngine, EngineChunk } from './engine.js';
import { createConversation } from './loop.js';
import {
	type AgentMessage,
	agentMessageText,
	isPersistableMessage,
} from './message.js';
import {
	type AgentToolCall,
	type Approval,
	defaultApprovalDecision,
	type ToolCatalog,
} from './tools.js';

/**
 * A disposable store over an in-memory doc, matching what `docs.open()` returns
 * in an app (the open wrapper adds disposal; `attachKvStore` alone does not).
 */
function makeStore() {
	const doc = new Y.Doc();
	const handle = attachKvStore<AgentMessage>(doc);
	return Object.assign(handle, {
		[Symbol.dispose]() {
			doc.destroy();
		},
	});
}

function streamOf(chunks: EngineChunk[]): AsyncIterable<EngineChunk> {
	return (async function* () {
		for (const value of chunks) yield value;
	})();
}

/** A monotonic id minter for deterministic message ids. */
function idMinter() {
	let n = 0;
	return () => `m${++n}`;
}

/** Drive pending turns to completion. */
async function settle(handle: { snapshot(): { isGenerating: boolean } }) {
	for (let i = 0; i < 200 && handle.snapshot().isGenerating; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

describe('createConversation', () => {
	test('persists a finished text turn as user + assistant messages', async () => {
		const store = makeStore();
		const engine: AgentEngine = () =>
			streamOf([
				{ type: 'text-delta', delta: 'Hello' },
				{ type: 'text-delta', delta: ' world' },
			]);

		const handle = createConversation({
			store,
			engine,
			generateId: idMinter(),
		});
		handle.send('hi');
		await settle(handle);

		const messages = handle.snapshot().messages;
		expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
		expect(agentMessageText(messages[0]!)).toBe('hi');
		expect(agentMessageText(messages[1]!)).toBe('Hello world');
		expect(handle.snapshot().isGenerating).toBe(false);
		// The finished messages are durable: a fresh read of the store sees them.
		expect([...store.entries()]).toHaveLength(2);
	});

	test('runs a query tool inline and re-prompts with its result', async () => {
		const store = makeStore();
		let stepCount = 0;
		const engine: AgentEngine = () => {
			stepCount += 1;
			if (stepCount === 1) {
				return streamOf([
					{
						type: 'tool-call',
						toolCallId: 't1',
						toolName: 'get_time',
						input: {},
					},
				]);
			}
			return streamOf([{ type: 'text-delta', delta: 'It is noon.' }]);
		};
		const resolved: AgentToolCall[] = [];
		const tools: ToolCatalog = {
			definitions: () => [{ name: 'get_time', kind: 'query' }],
			resolve: async (call) => {
				resolved.push(call);
				return { output: 'noon', isError: false };
			},
		};

		const handle = createConversation({
			store,
			engine,
			tools,
			generateId: idMinter(),
		});
		handle.send('what time is it');
		await settle(handle);

		expect(resolved.map((c) => c.toolName)).toEqual(['get_time']);
		const messages = handle.snapshot().messages;
		expect(messages.map((m) => m.role)).toEqual([
			'user',
			'assistant',
			'assistant',
		]);

		const toolStep = messages[1]!;
		expect(toolStep.parts.find((p) => p.type === 'tool-call')).toMatchObject({
			toolName: 'get_time',
		});
		expect(toolStep.parts.find((p) => p.type === 'tool-result')).toMatchObject({
			output: 'noon',
			isError: false,
		});
		expect(agentMessageText(messages[2]!)).toBe('It is noon.');
	});

	test('an asked mutation that is declined records a denial, never resolves', async () => {
		const store = makeStore();
		let stepCount = 0;
		const engine: AgentEngine = () => {
			stepCount += 1;
			if (stepCount === 1) {
				return streamOf([
					{
						type: 'tool-call',
						toolCallId: 'd1',
						toolName: 'delete_all',
						input: {},
					},
				]);
			}
			return streamOf([{ type: 'text-delta', delta: 'Okay, I will not.' }]);
		};
		let resolveCalled = false;
		const tools: ToolCatalog = {
			definitions: () => [{ name: 'delete_all', kind: 'mutation' }],
			resolve: async () => {
				resolveCalled = true;
				return { output: 'deleted', isError: false };
			},
		};
		const approval: Approval = {
			decide: defaultApprovalDecision,
			request: async () => false,
		};

		const handle = createConversation({
			store,
			engine,
			tools,
			approval,
			generateId: idMinter(),
		});
		handle.send('delete everything');
		await settle(handle);

		expect(resolveCalled).toBe(false);
		const toolStep = handle.snapshot().messages[1]!;
		expect(toolStep.parts.find((p) => p.type === 'tool-result')).toMatchObject({
			isError: true,
		});
	});

	test('an aborted turn drops its assistant message, keeping only the user turn', async () => {
		const store = makeStore();
		const engine: AgentEngine = () =>
			streamOf([{ type: 'text-delta', delta: 'partial' }]);

		const handle = createConversation({
			store,
			engine,
			generateId: idMinter(),
		});
		handle.send('hi');
		handle.stop();
		await settle(handle);

		const messages = handle.snapshot().messages;
		expect(messages.map((m) => m.role)).toEqual(['user']);
		expect(handle.snapshot().isGenerating).toBe(false);
	});

	// Guards the snapshot/persistence coupling: the live render filter and the
	// persistence filter must use one predicate, or a message could render
	// mid-turn and then vanish on a clean finish. See `snapshot` in loop.ts.
	test('every assistant message that renders live also persists', async () => {
		const store = makeStore();
		const engine: AgentEngine = () =>
			streamOf([{ type: 'text-delta', delta: 'streamed' }]);

		const handle = createConversation({
			store,
			engine,
			generateId: idMinter(),
		});

		// Record every assistant id that ever appears in a live snapshot.
		const renderedLive = new Set<string>();
		const unsubscribe = handle.subscribe(() => {
			if (!handle.snapshot().isGenerating) return;
			for (const message of handle.snapshot().messages) {
				if (message.role === 'assistant') renderedLive.add(message.id);
			}
		});

		handle.send('hi');
		await settle(handle);
		unsubscribe();

		const persisted = new Set(
			[...store.entries()]
				.map((entry) => entry.val)
				.filter((message) => message.role === 'assistant')
				.map((message) => message.id),
		);
		expect([...renderedLive].sort()).toEqual([...persisted].sort());
		expect(persisted.size).toBe(1);
	});

	// The discriminator the shared predicate closes: a message can hold parts yet
	// not be persistable (an empty text part). `parts.length > 0` would render it
	// live; `isPersistableMessage` (used by both filters) drops it consistently.
	test('a parts-bearing but empty message is not persistable', () => {
		const message: AgentMessage = {
			id: 'm1',
			role: 'assistant',
			createdAt: 0,
			parts: [{ type: 'text', text: '' }],
		};
		expect(message.parts.length).toBeGreaterThan(0);
		expect(isPersistableMessage(message)).toBe(false);
	});
});
