import { describe, expect, test } from 'bun:test';
import { Ok, type Result } from 'wellcrafted/result';
import { DispatchError, type DispatchRequest } from '../document/dispatch.js';
import type { ActionMeta } from '../shared/actions.js';
import { defineActions, defineQuery } from '../shared/actions.js';
import {
	createDispatchToolCatalog,
	type DispatchSurface,
} from './dispatch-catalog.js';

function peer(nodeId: string, actions: Record<string, ActionMeta>) {
	return { nodeId, connectedAt: 0, actions };
}

/** A surface with a fixed peer list and a scripted dispatch outcome. */
function surfaceOf(
	peers: ReturnType<typeof peer>[],
	dispatch: (
		request: DispatchRequest,
	) => Promise<Result<unknown, DispatchError>> = async () => Ok(null),
): DispatchSurface {
	return { peers: { list: () => peers }, dispatch };
}

const NO_SIGNAL = new AbortController().signal;

describe('createDispatchToolCatalog', () => {
	test('merges local actions and remote peer manifests, local shadowing remote', () => {
		const localActions = defineActions({
			local_now: defineQuery({
				description: 'local clock',
				handler: () => ({ now: 1 }),
			}),
		});
		const surface = surfaceOf([
			peer('daemon', {
				local_now: { type: 'query', description: 'remote clock' },
				books_query: { type: 'query', description: 'read books' },
			}),
		]);

		const catalog = createDispatchToolCatalog(surface, { localActions });
		const definitions = catalog.definitions();

		const byName = new Map(definitions.map((d) => [d.name, d]));
		expect([...byName.keys()].sort()).toEqual(['books_query', 'local_now']);
		// The local definition shadows the remote of the same name.
		expect(byName.get('local_now')?.description).toBe('local clock');
		expect(byName.get('books_query')?.kind).toBe('query');
	});

	test('resolves a local action in-process without dispatching', async () => {
		let dispatched = false;
		const localActions = defineActions({
			local_now: defineQuery({ handler: () => ({ now: 7 }) }),
		});
		const surface = surfaceOf([], async () => {
			dispatched = true;
			return Ok(null);
		});

		const catalog = createDispatchToolCatalog(surface, { localActions });
		const outcome = await catalog.resolve(
			{ toolCallId: 'c1', toolName: 'local_now', input: {} },
			NO_SIGNAL,
		);

		expect(dispatched).toBe(false);
		expect(outcome).toEqual({ output: { now: 7 }, isError: false });
	});

	test('dispatches a remote action to the peer that advertises it', async () => {
		const seen: DispatchRequest[] = [];
		const surface = surfaceOf(
			[peer('daemon', { books_query: { type: 'query' } })],
			async (request) => {
				seen.push(request);
				return Ok({ rows: 3 });
			},
		);

		const catalog = createDispatchToolCatalog(surface);
		const outcome = await catalog.resolve(
			{ toolCallId: 'c2', toolName: 'books_query', input: { sql: 'SELECT 1' } },
			NO_SIGNAL,
		);

		expect(seen).toEqual([
			{
				to: 'daemon',
				action: 'books_query',
				input: { sql: 'SELECT 1' },
				signal: NO_SIGNAL,
			},
		]);
		expect(outcome).toEqual({ output: { rows: 3 }, isError: false });
	});

	test('a failed dispatch becomes an error outcome the model can read', async () => {
		const surface = surfaceOf(
			[peer('daemon', { books_query: { type: 'query' } })],
			async () =>
				DispatchError.ActionFailed({ action: 'books_query', cause: 'boom' }),
		);

		const catalog = createDispatchToolCatalog(surface);
		const outcome = await catalog.resolve(
			{ toolCallId: 'c3', toolName: 'books_query', input: {} },
			NO_SIGNAL,
		);

		expect(outcome.isError).toBe(true);
		expect(typeof outcome.output).toBe('string');
	});

	test('an unknown tool resolves to an error rather than throwing', async () => {
		const catalog = createDispatchToolCatalog(surfaceOf([]));
		const outcome = await catalog.resolve(
			{ toolCallId: 'c4', toolName: 'nope', input: {} },
			NO_SIGNAL,
		);

		expect(outcome.isError).toBe(true);
	});

	test('skips the caller own node when scanning presence for tools', () => {
		const surface = surfaceOf([
			peer('me', { secret: { type: 'mutation' } }),
			peer('daemon', { books_query: { type: 'query' } }),
		]);

		const catalog = createDispatchToolCatalog(surface, { selfNodeId: 'me' });
		expect(catalog.definitions().map((d) => d.name)).toEqual(['books_query']);
	});

	test('an asked mutation is marked so the loop can gate it', () => {
		const surface = surfaceOf([
			peer('daemon', {
				mark_reviewed: { type: 'mutation', title: 'Mark reviewed' },
			}),
		]);
		const catalog = createDispatchToolCatalog(surface);
		const [definition] = catalog.definitions();
		expect(definition).toMatchObject({
			name: 'mark_reviewed',
			kind: 'mutation',
		});
	});
});
