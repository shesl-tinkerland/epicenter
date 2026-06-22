/**
 * Device-local chat store tests (ADR-0051).
 *
 * The store is the device-local half of the converged agent loop: an
 * IndexedDB-backed `KvStoreHandle<AgentMessage>` the loop writes finished
 * messages into. These tests pin the behavior the loop depends on: a handle
 * hydrates its conversation's messages, by-id writes round-trip, conversations
 * stay isolated by key range, and `observe` fires on both writes and hydration.
 */

/// <reference types="bun" />

import { afterEach, describe, expect, test } from 'bun:test';
import type { AgentMessage } from '@epicenter/workspace/agent';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';

Object.assign(globalThis, { indexedDB, IDBKeyRange });

const {
	asConversationId,
	attachConversationStore,
	clearConversation,
	loadAllConversations,
	getAllModelChoices,
	setModelChoice,
	deleteModelChoice,
} = await import('./persistence');

/** Let the store's async hydration and ordered write queue settle. */
async function settle(): Promise<void> {
	for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

function userMessage(
	id: string,
	text: string,
	createdAt: number,
): AgentMessage {
	return { id, role: 'user', createdAt, parts: [{ type: 'text', text }] };
}

let counter = 0;
/** A unique conversation id per test, so the shared fake IDB never collides. */
function freshConversationId() {
	counter += 1;
	return asConversationId(`conv-${counter}`);
}

const opened: Array<{ [Symbol.dispose](): void }> = [];
afterEach(() => {
	for (const handle of opened.splice(0)) handle[Symbol.dispose]();
});

function open(conversationId: ReturnType<typeof asConversationId>) {
	const store = attachConversationStore(conversationId);
	opened.push(store);
	return store;
}

describe('attachConversationStore', () => {
	test('persists by id and hydrates into a fresh handle', async () => {
		const id = freshConversationId();
		const writer = open(id);
		writer.set('m1', userMessage('m1', 'first', 1));
		writer.set('m2', userMessage('m2', 'second', 2));
		await settle();

		const reader = open(id);
		await settle();
		const texts = [...reader.entries()].map((e) => e.val.parts);
		expect(reader.get('m1')?.createdAt).toBe(1);
		expect([...reader.entries()].map((e) => e.key).sort()).toEqual([
			'm1',
			'm2',
		]);
		expect(texts).toHaveLength(2);
	});

	test('isolates conversations by key range', async () => {
		const a = freshConversationId();
		const b = freshConversationId();
		open(a).set('x', userMessage('x', 'in a', 1));
		open(b).set('y', userMessage('y', 'in b', 1));
		await settle();

		const readerA = open(a);
		await settle();
		expect([...readerA.entries()].map((e) => e.key)).toEqual(['x']);
		expect(readerA.get('y')).toBeUndefined();
	});

	test('observe fires on a write and on hydration', async () => {
		const id = freshConversationId();
		const writer = open(id);
		let writeFires = 0;
		writer.observe(() => {
			writeFires += 1;
		});
		writer.set('m1', userMessage('m1', 'hi', 1));
		expect(writeFires).toBe(1);
		await settle();

		const reader = open(id);
		let hydrateFires = 0;
		reader.observe(() => {
			hydrateFires += 1;
		});
		await settle();
		expect(hydrateFires).toBeGreaterThanOrEqual(1);
		expect(reader.get('m1')?.parts[0]).toEqual({ type: 'text', text: 'hi' });
	});

	test('delete removes a message and clearConversation wipes the rest', async () => {
		const id = freshConversationId();
		const writer = open(id);
		writer.set('m1', userMessage('m1', 'one', 1));
		writer.set('m2', userMessage('m2', 'two', 2));
		await settle();
		writer.delete('m1');
		await settle();

		expect(open(id)).toBeDefined();
		const afterDelete = open(id);
		await settle();
		expect([...afterDelete.entries()].map((e) => e.key)).toEqual(['m2']);

		await clearConversation(id);
		const afterClear = open(id);
		await settle();
		expect([...afterClear.entries()]).toHaveLength(0);
	});

	test('a wipe issued before a write settles still removes that write', async () => {
		const id = freshConversationId();
		const writer = open(id);
		writer.set('m1', userMessage('m1', 'one', 1));
		// No settle: the put is still queued. The shared write queue must commit
		// the wipe after the put, never before it, or the row would resurrect.
		await clearConversation(id);
		const reader = open(id);
		await settle();
		expect([...reader.entries()]).toHaveLength(0);
	});
});

describe('conversation enumeration', () => {
	test('loadAllConversations reports the latest message timestamp', async () => {
		const id = freshConversationId();
		const writer = open(id);
		writer.set('m1', userMessage('m1', 'early', 100));
		writer.set('m2', userMessage('m2', 'late', 500));
		await settle();

		const all = await loadAllConversations();
		const entry = all.find((c) => c.id === id);
		expect(entry?.lastActivity).toBe(500);
	});
});

describe('model choices', () => {
	test('round-trip and delete a model choice', async () => {
		const id = freshConversationId();
		await setModelChoice(id, { model: 'gpt-5.5' });
		expect((await getAllModelChoices()).get(id)).toEqual({ model: 'gpt-5.5' });

		await deleteModelChoice(id);
		expect((await getAllModelChoices()).get(id)).toBeUndefined();
	});
});
