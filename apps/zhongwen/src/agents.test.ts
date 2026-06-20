/**
 * The agent catalog's routing invariants (ADR-0025/0033).
 *
 * The browser answers a conversation in-process (the Epicenter provider sourcing
 * tokens from `/api/ai/chat`) for, and only for, a bound agent that is NOT
 * daemon-runtime; a daemon-runtime agent is a resident listener left to answer
 * ambiently over sync (`ConversationView` reads `agentConfig().runtime`). These
 * tests pin the catalog data that fork reads, so flipping the cloud agent's
 * runtime (which would silently strand it: the browser would stop answering and
 * defer to a daemon that isn't there) fails here instead of in the UI.
 */

import { describe, expect, test } from 'bun:test';
import { asAgentId } from '@epicenter/workspace';
import {
	agentConfig,
	CLOUD_AGENT_ID,
	DEFAULT_AGENT_ID,
	ZHONGWEN_AGENTS,
} from '../zhongwen.js';

describe('agent catalog', () => {
	test('the cloud agent is cloud-runtime so the browser answers it in-process', () => {
		expect(agentConfig(CLOUD_AGENT_ID)?.runtime).toBe('cloud');
	});

	test('the default agent resolves to a cloud-runtime agent (no daemon required)', () => {
		expect(agentConfig(DEFAULT_AGENT_ID)?.runtime).toBe('cloud');
	});

	test('the home daemon is daemon-runtime so the browser leaves it to sync', () => {
		expect(agentConfig(asAgentId('zhongwen-home'))?.runtime).toBe('daemon');
	});

	test('an id no longer in the catalog resolves to undefined, never answered', () => {
		expect(agentConfig(asAgentId('gone'))).toBeUndefined();
	});

	test('every catalog id is unique (one entry per agent)', () => {
		const ids = ZHONGWEN_AGENTS.map((agent) => agent.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
