/**
 * The agent catalog's routing invariants (ADR-0025).
 *
 * The browser nudges the HTTP route for, and only for, a conversation whose bound
 * agent has `runtime: 'cloud'` (`ConversationView.nudgeBoundAgent`); everything
 * else is left to a daemon over sync. These tests pin the catalog data that fork
 * reads, so flipping the cloud agent's runtime (which would silently strand the
 * cloud path: no nudge, no daemon) fails here instead of in the UI.
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
	test('the cloud agent is cloud-runtime so the browser nudges its HTTP route', () => {
		expect(agentConfig(CLOUD_AGENT_ID)?.runtime).toBe('cloud');
	});

	test('the default agent resolves to a cloud-runtime agent (no daemon required)', () => {
		expect(agentConfig(DEFAULT_AGENT_ID)?.runtime).toBe('cloud');
	});

	test('the home daemon is daemon-runtime so the browser leaves it to sync', () => {
		expect(agentConfig(asAgentId('zhongwen-home'))?.runtime).toBe('daemon');
	});

	test('an id no longer in the catalog resolves to undefined, never nudged', () => {
		expect(agentConfig(asAgentId('gone'))).toBeUndefined();
	});

	test('every catalog id is unique (one entry per agent)', () => {
		const ids = ZHONGWEN_AGENTS.map((agent) => agent.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
