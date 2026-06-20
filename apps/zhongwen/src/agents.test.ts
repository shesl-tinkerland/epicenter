/**
 * The agent catalog's routing invariants (ADR-0025/0033).
 *
 * The browser answers a conversation in-process (the Epicenter provider sourcing
 * tokens from `/api/ai/chat`) for, and only for, a bound agent the open tab owns
 * (`owner: 'ephemeral'`); a `'durable'`-owner agent is a resident daemon left to
 * answer ambiently over sync (`ConversationView` reads `agentConfig().owner`).
 * These tests pin the catalog data that fork reads, so flipping the cloud agent's
 * owner (which would silently strand it: the browser would stop answering and
 * defer to a daemon that isn't there) fails here instead of in the UI.
 */

import { describe, expect, test } from 'bun:test';
import { asAgentId } from '@epicenter/workspace';
import type { ChatStream } from '@epicenter/workspace/ai';
import {
	agentConfig,
	DEFAULT_AGENT_ID,
	resolveEngine,
	THIS_DEVICE_AGENT_ID,
	ZHONGWEN_AGENTS,
} from '../zhongwen.js';

describe('agent catalog', () => {
	test('the this-device agent is ephemeral-owned so the browser answers it in-process', () => {
		expect(agentConfig(THIS_DEVICE_AGENT_ID)?.owner).toBe('ephemeral');
	});

	test('the default agent resolves to an ephemeral-owned agent (no daemon required)', () => {
		expect(agentConfig(DEFAULT_AGENT_ID)?.owner).toBe('ephemeral');
	});

	test('the home daemon is durable-owned so the browser leaves it to sync', () => {
		expect(agentConfig(asAgentId('zhongwen-home'))?.owner).toBe('durable');
	});

	test('an id no longer in the catalog resolves to undefined, never answered', () => {
		expect(agentConfig(asAgentId('gone'))).toBeUndefined();
	});

	test('every catalog id is unique (one entry per agent)', () => {
		const ids = ZHONGWEN_AGENTS.map((agent) => agent.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe('resolveEngine', () => {
	// Distinct sentinel streams so a test can assert *which* engine won.
	const primary: ChatStream = async function* () {};
	const fallback: ChatStream = async function* () {};

	test('takes the first engine the host can power', () => {
		expect(resolveEngine([() => primary, () => fallback])).toBe(primary);
	});

	test('falls through a null engine to the next in priority order', () => {
		expect(resolveEngine([() => null, () => fallback])).toBe(fallback);
	});

	test('no satisfiable engine hosts without answering (null)', () => {
		expect(resolveEngine([() => null, () => null])).toBeNull();
	});

	test('an empty engine list answers nothing', () => {
		expect(resolveEngine([])).toBeNull();
	});
});
