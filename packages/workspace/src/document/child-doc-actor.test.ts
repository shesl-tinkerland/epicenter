/**
 * Child-doc observe loop tests. The loop is driven with an in-memory
 * `connectBody` (no disk, no sockets), so these exercise the loop itself:
 * enumerate rows, open + observe each body, run the per-body actor, dispose a
 * body whose row is gone, and flush every body on root destroy.
 */

import { describe, expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import * as Y from 'yjs';
import { appendUserMessage, attachChatTranscript } from '../ai/index.js';
import {
	attachChildDocActor,
	type ConnectedChildDoc,
} from './child-doc-actor.js';
import { defineTable } from './define-table.js';
import { createWorkspace } from './workspace.js';

const conversationsDefinition = defineTable({
	id: field.string(),
	title: field.string(),
}).docs({ messages: attachChatTranscript });

/**
 * Build a workspace plus an in-memory body connector. The connector records
 * every opened body by guid (so a test can write into the same replica the loop
 * holds) and resolves `whenDisposed` on `ydoc.destroy()`.
 */
function setup() {
	const workspace = createWorkspace({
		id: 'ws-actor-test',
		tables: { conversations: conversationsDefinition },
		kv: {},
	});
	const bodies = new Map<string, Y.Doc>();
	const connectBody = (guid: string): ConnectedChildDoc => {
		const ydoc = new Y.Doc({ guid, gc: true });
		bodies.set(guid, ydoc);
		const { promise: whenDisposed, resolve } = Promise.withResolvers<void>();
		ydoc.once('destroy', () => resolve());
		return {
			ydoc,
			whenDisposed,
			dispose() {
				ydoc.destroy();
			},
		};
	};
	return { workspace, bodies, connectBody };
}

/** The common args, with a no-op actor unless a test overrides `actorFor`. */
function actorArgs(
	workspace: ReturnType<typeof setup>['workspace'],
	connectBody: ReturnType<typeof setup>['connectBody'],
) {
	const { conversations } = workspace.tables;
	return {
		rootDoc: workspace.ydoc,
		table: conversations,
		guidFor: conversations.docs.messages.guid,
		connectBody,
		layout: attachChatTranscript,
		actorFor: () => ({}),
		// Designation is the loop's filter; most tests host every row, and the
		// designation-specific tests below override it. The schema-derived
		// `row.agent === selfAgentId` composition lives in the mount coordinator
		// (workspace-mount.test.ts), not here.
		isDesignated: () => true,
	};
}

describe('attachChildDocActor', () => {
	test('opens a body for each conversation row', () => {
		const { workspace, bodies, connectBody } = setup();
		const { conversations } = workspace.tables;
		conversations.set({ id: 'c1', title: 'first' });
		conversations.set({ id: 'c2', title: 'second' });

		const actor = attachChildDocActor(actorArgs(workspace, connectBody));

		expect(bodies.has(conversations.docs.messages.guid('c1'))).toBe(true);
		expect(bodies.has(conversations.docs.messages.guid('c2'))).toBe(true);

		actor[Symbol.dispose]();
		workspace[Symbol.dispose]();
	});

	test('opens a body for a row added after start', () => {
		const { workspace, bodies, connectBody } = setup();
		const { conversations } = workspace.tables;

		const actor = attachChildDocActor(actorArgs(workspace, connectBody));
		expect(bodies.size).toBe(0);

		conversations.set({ id: 'c1', title: 'later' });
		expect(bodies.has(conversations.docs.messages.guid('c1'))).toBe(true);

		actor[Symbol.dispose]();
		workspace[Symbol.dispose]();
	});

	test('runs the per-body actor and fires onChange on a transcript change', () => {
		const { workspace, bodies, connectBody } = setup();
		const { conversations } = workspace.tables;
		conversations.set({ id: 'c1', title: 'first' });

		const built: string[] = [];
		const changed: string[] = [];
		const actor = attachChildDocActor({
			...actorArgs(workspace, connectBody),
			actorFor: ({ rowId }) => {
				built.push(rowId);
				return { onChange: () => changed.push(rowId) };
			},
		});

		// The actor is built once per opened body, before any change.
		expect(built).toEqual(['c1']);

		const body = bodies.get(conversations.docs.messages.guid('c1'))!;
		appendUserMessage(body, {
			id: 'm1',
			content: 'hi',
			createdAt: 1,
			generationId: 'g1',
		});

		expect(changed).toEqual(['c1']);

		actor[Symbol.dispose]();
		workspace[Symbol.dispose]();
	});

	test('hosts only the rows the designation predicate selects', () => {
		const { workspace, bodies, connectBody } = setup();
		const { conversations } = workspace.tables;
		conversations.set({ id: 'mine', title: 'a' });
		conversations.set({ id: 'theirs', title: 'b' });

		// The actor reconciles only its node's conversations; an undesignated row
		// stays available through the anchor, never hosted here.
		const actor = attachChildDocActor({
			...actorArgs(workspace, connectBody),
			isDesignated: (rowId) => rowId === 'mine',
		});

		expect(bodies.has(conversations.docs.messages.guid('mine'))).toBe(true);
		expect(bodies.has(conversations.docs.messages.guid('theirs'))).toBe(false);

		actor[Symbol.dispose]();
		workspace[Symbol.dispose]();
	});

	test('opens and closes a body as its designation flips', () => {
		const { workspace, bodies, connectBody } = setup();
		const { conversations } = workspace.tables;
		conversations.set({ id: 'c1', title: 'a' });

		let designated = false;
		const actor = attachChildDocActor({
			...actorArgs(workspace, connectBody),
			isDesignated: () => designated,
		});
		const guid = conversations.docs.messages.guid('c1');
		expect(bodies.has(guid)).toBe(false); // undesignated: not hosted

		// A row write fires the table observer, so reconcile re-evaluates
		// designation and opens the now-designated body.
		designated = true;
		conversations.set({ id: 'c1', title: 'a2' });
		const body = bodies.get(guid);
		expect(body?.isDestroyed).toBe(false);

		// Re-designated away: the body is torn down.
		designated = false;
		conversations.set({ id: 'c1', title: 'a3' });
		expect(body?.isDestroyed).toBe(true);

		actor[Symbol.dispose]();
		workspace[Symbol.dispose]();
	});

	test('disposes a body and its actor when the row is removed', () => {
		const { workspace, bodies, connectBody } = setup();
		const { conversations } = workspace.tables;
		conversations.set({ id: 'c1', title: 'first' });

		const disposed: string[] = [];
		const actor = attachChildDocActor({
			...actorArgs(workspace, connectBody),
			actorFor: ({ rowId }) => ({
				[Symbol.dispose]: () => disposed.push(rowId),
			}),
		});
		const body = bodies.get(conversations.docs.messages.guid('c1'))!;
		expect(body.isDestroyed).toBe(false);

		conversations.delete('c1');
		expect(disposed).toEqual(['c1']);
		expect(body.isDestroyed).toBe(true);

		actor[Symbol.dispose]();
		workspace[Symbol.dispose]();
	});

	test('flushes every hosted body on root destroy', async () => {
		const { workspace, bodies, connectBody } = setup();
		const { conversations } = workspace.tables;
		conversations.set({ id: 'c1', title: 'first' });
		conversations.set({ id: 'c2', title: 'second' });

		const actor = attachChildDocActor(actorArgs(workspace, connectBody));

		workspace[Symbol.dispose]();
		await actor.whenDisposed;

		for (const body of bodies.values()) {
			expect(body.isDestroyed).toBe(true);
		}
	});
});
