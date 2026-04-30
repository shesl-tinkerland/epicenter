/**
 * Tool bridge tests: verifies the mapping between workspace actions and
 * TanStack AI tool representations.
 */

import { describe, expect, test } from 'bun:test';
import { defineMutation, defineQuery } from '@epicenter/sync';
import { Err, Ok } from 'wellcrafted/result';
import { actionsToAiTools } from './tool-bridge.js';

describe('actionsToAiTools', () => {
	describe('tools', () => {
		test('all mutations get needsApproval', () => {
			const actions = {
				tabs: {
					close: defineMutation({
						title: 'Close Tabs',
						description: 'Close tabs',
						handler: () => {},
					}),
					open: defineMutation({
						title: 'Open Tab',
						description: 'Open a tab',
						handler: () => {},
					}),
				},
			};

			const { tools } = actionsToAiTools(actions);

			const closeTool = tools.find((t) => t.name === 'tabs_close');
			expect(closeTool).toBeDefined();
			expect(closeTool?.needsApproval).toBe(true);

			const openTool = tools.find((t) => t.name === 'tabs_open');
			expect(openTool).toBeDefined();
			expect(openTool?.needsApproval).toBe(true);
		});

		test('queries omit needsApproval entirely', () => {
			const actions = {
				query: defineQuery({
					title: 'Query',
					description: 'Query data',
					handler: () => {},
				}),
				mutation: defineMutation({
					title: 'Mutation',
					description: 'Mutate data',
					handler: () => {},
				}),
			};

			const { tools } = actionsToAiTools(actions);

			const queryTool = tools.find((t) => t.name === 'query');
			expect(queryTool).toBeDefined();
			expect('needsApproval' in queryTool!).toBe(false);

			const mutationTool = tools.find((t) => t.name === 'mutation');
			expect(mutationTool).toBeDefined();
			expect(mutationTool?.needsApproval).toBe(true);
		});
	});

	describe('definitions', () => {
		test('produces wire-safe definitions with title', () => {
			const actions = {
				search: defineQuery({
					title: 'Search',
					description: 'Search stuff',
					handler: () => {},
				}),
			};

			const { definitions } = actionsToAiTools(actions);

			expect(definitions).toHaveLength(1);
			expect(definitions[0]?.name).toBe('search');
			expect(definitions[0]?.title).toBe('Search');
			expect(definitions[0]?.description).toBe('Search stuff');
		});

		test('forwards needsApproval for mutations, not queries', () => {
			const actions = {
				save: defineMutation({
					title: 'Save',
					description: 'Save action',
					handler: () => {},
				}),
				safe: defineQuery({
					title: 'Safe',
					description: 'Safe action',
					handler: () => {},
				}),
			};

			const { definitions } = actionsToAiTools(actions);

			const saveDef = definitions.find((d) => d.name === 'save');
			expect(saveDef?.needsApproval).toBe(true);

			const safeDef = definitions.find((d) => d.name === 'safe');
			expect('needsApproval' in safeDef!).toBe(false);
		});

		test('omits title when action has no title', () => {
			const actions = {
				untitled: defineQuery({
					description: 'No title here',
					handler: () => {},
				}),
			};

			const { definitions } = actionsToAiTools(actions);

			expect('title' in definitions[0]!).toBe(false);
		});
	});

	describe('execute', () => {
		// TanStack AI expects `execute` to return tool output on success and
		// throw on failure. The bridge detects Result envelopes at runtime so
		// handlers can stay ergonomic (raw or Result) without the LLM ever
		// seeing a `{data, error}` envelope as tool output.

		test('returns raw value from a raw-returning handler', async () => {
			const actions = {
				count: defineQuery({ handler: () => ({ count: 42 }) }),
			};

			const { tools } = actionsToAiTools(actions);
			const tool = tools.find((t) => t.name === 'count')!;
			if (!tool.execute) throw new Error('execute missing');

			expect(await tool.execute(undefined)).toEqual({ count: 42 });
		});

		test('unwraps Ok to .data so the LLM never sees the envelope', async () => {
			const actions = {
				count: defineQuery({ handler: () => Ok({ count: 42 }) }),
			};

			const { tools } = actionsToAiTools(actions);
			const tool = tools.find((t) => t.name === 'count')!;
			if (!tool.execute) throw new Error('execute missing');

			expect(await tool.execute(undefined)).toEqual({ count: 42 });
		});

		test('throws on Err so TanStack AI surfaces the failure as a tool error', async () => {
			const actions = {
				boom: defineQuery({
					handler: () =>
						Err({ name: 'Boom', message: 'everything is on fire' }),
				}),
			};

			const { tools } = actionsToAiTools(actions);
			const tool = tools.find((t) => t.name === 'boom')!;
			if (!tool.execute) throw new Error('execute missing');

			await expect(tool.execute(undefined)).rejects.toMatchObject({
				name: 'Boom',
				message: 'everything is on fire',
			});
		});

		test('propagates thrown errors from the handler unchanged', async () => {
			const actions = {
				crash: defineQuery({
					handler: () => {
						throw new Error('internal bug');
					},
				}),
			};

			const { tools } = actionsToAiTools(actions);
			const tool = tools.find((t) => t.name === 'crash')!;
			if (!tool.execute) throw new Error('execute missing');

			await expect(tool.execute(undefined)).rejects.toThrow('internal bug');
		});
	});
});
