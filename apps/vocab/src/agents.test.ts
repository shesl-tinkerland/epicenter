/**
 * The agent catalog's routing invariants (ADR-0025/0043).
 *
 * An agent answers where its capability lives, and the bound agent id is what
 * names that place: the client tab answers the capability-free
 * {@link CLIENT_AGENT_ID} in-process (the Epicenter provider sourcing tokens from
 * `/api/ai/chat`), while `vocab-home` is a resident daemon that answers its own
 * conversations over sync (`ConversationView` compares `row.agent` to
 * `CLIENT_AGENT_ID`). These tests pin the catalog data that routing reads, so
 * renaming or dropping the client agent (which would silently strand the default
 * "New Conversation" path) fails here instead of in the UI.
 */

import { describe, expect, test } from 'bun:test';
import { asAgentId } from '@epicenter/workspace';
import { CLIENT_AGENT_ID, DEFAULT_AGENT_ID, VOCAB_AGENTS } from '../vocab.js';

describe('agent catalog', () => {
	test('the default agent is the client agent (no daemon required)', () => {
		expect(DEFAULT_AGENT_ID).toBe(CLIENT_AGENT_ID);
	});

	test('the catalog binds exactly the client tab and the home daemon', () => {
		const ids = VOCAB_AGENTS.map((agent) => agent.id);
		expect(ids).toEqual([CLIENT_AGENT_ID, asAgentId('vocab-home')]);
	});

	test('every catalog id is unique (one entry per agent)', () => {
		const ids = VOCAB_AGENTS.map((agent) => agent.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
