/**
 * `buildRemoteProxy<T>()` unit tests: pure proxy mechanics, decoupled from
 * any peer-resolution or transport. Verifies the dot-path becomes the
 * action string passed to `send`, that returned `Result` envelopes pass
 * through unchanged, and that thrown errors are normalized to
 * `RpcError.ActionFailed`. Peer-resolution and peer-removed race semantics
 * live on `SyncAttachment.peer()` and are covered in workspace's
 * `attach-sync.test.ts`.
 */

import { describe, expect, it } from 'bun:test';
import Type from 'typebox';
import { Err, Ok, isErr } from 'wellcrafted/result';
import type { Result } from 'wellcrafted/result';
import { defineMutation, defineQuery } from './actions';
import { buildRemoteProxy, type Sender } from './peer';
import { RpcError, isRpcError } from './rpc-errors';

// Reference action shape used to type the test proxy. Handlers are never
// invoked here: only the *type* flows through `buildRemoteProxy<TestActions>`.
const TestActions = {
	tabs: {
		close: defineMutation({
			input: Type.Object({ tabIds: Type.Array(Type.Number()) }),
			handler: (_input): { closedCount: number } => ({ closedCount: 0 }),
		}),
	},
	x: defineQuery({ handler: (): unknown => undefined }),
};
type TestActions = typeof TestActions;

describe('buildRemoteProxy<T>()', () => {
	it('builds a proxy whose dot-path becomes the action string passed to send', async () => {
		const calls: Array<{ path: string; input: unknown; options?: unknown }> =
			[];
		const send: Sender = async (path, input, options) => {
			calls.push({ path, input, options });
			return Ok({ closedCount: 1 });
		};

		const remote = buildRemoteProxy<TestActions>(send);
		const result = await remote.tabs.close({ tabIds: [1] }, { timeout: 1000 });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.path).toBe('tabs.close');
		expect(calls[0]?.input).toEqual({ tabIds: [1] });
		expect(calls[0]?.options).toEqual({ timeout: 1000 });
		expect(result.error).toBeNull();
		expect(result.data).toEqual({ closedCount: 1 });
	});

	it('passes a Result through unchanged when send returns one', async () => {
		const send: Sender = async () =>
			Err(RpcError.ActionNotFound({ action: 'x' }).error);

		const remote = buildRemoteProxy<TestActions>(send);
		const result = await remote.x();
		expect(isErr(result)).toBe(true);
		if (isErr(result) && isRpcError(result.error)) {
			expect(result.error.name).toBe('ActionNotFound');
		}
	});

	it('wraps a raw (non-Result) return value as Ok', async () => {
		const send: Sender = async () =>
			({ closedCount: 7 }) as unknown as Result<unknown, RpcError>;

		const remote = buildRemoteProxy<TestActions>(send);
		const result = await remote.tabs.close({ tabIds: [1, 2] });
		expect(result.error).toBeNull();
		expect(result.data).toEqual({ closedCount: 7 });
	});

	it('normalizes a thrown error from send as RpcError.ActionFailed', async () => {
		const send: Sender = async () => {
			throw new Error('boom');
		};

		const remote = buildRemoteProxy<TestActions>(send);
		const result = await remote.tabs.close({ tabIds: [1] });
		expect(isErr(result)).toBe(true);
		if (isErr(result) && isRpcError(result.error)) {
			expect(result.error.name).toBe('ActionFailed');
		}
	});
});
