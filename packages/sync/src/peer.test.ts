/**
 * `peer<T>()` unit tests: proxy mechanics + first-match resolution +
 * disconnect short-circuit. Tests use a mock `PeerTransport`: no real
 * Y.Doc, no real WebSocket, no real awareness. The peer-resolution logic
 * itself is covered in workspace's `attach-sync.test.ts` (presence section).
 */

import { describe, expect, it } from 'bun:test';
import Type from 'typebox';
import { Err, Ok, isErr } from 'wellcrafted/result';
import type { Result } from 'wellcrafted/result';
import { defineMutation, defineQuery } from './actions';
import { peer, type PeerTransport } from './peer';
import { RpcError, isRpcError } from './rpc-errors';

// Reference action shape used to type the test proxy. Handlers are never
// invoked here: only the *type* flows through `peer<typeof TestActions>`.
const TestActions = {
	tabs: {
		close: defineMutation({
			input: Type.Object({ tabIds: Type.Array(Type.Number()) }),
			handler: (_input): { closedCount: number } => ({ closedCount: 0 }),
		}),
	},
	foo: {
		bar: defineMutation({
			input: Type.Object({}),
			handler: (): unknown => undefined,
		}),
	},
	x: defineQuery({ handler: (): unknown => undefined }),
};
type TestActions = typeof TestActions;

type RpcCall = {
	target: number;
	action: string;
	input?: unknown;
	options?: { timeout?: number };
};

/**
 * Mock `PeerTransport`: keeps a mutable `present` map of deviceId→clientId
 * so tests can drop a peer mid-call by mutating it and firing observers.
 */
function mockTransport({
	present: presentInit,
	respond,
	calls = [],
}: {
	present: Record<string, number>;
	respond: (call: RpcCall) => Promise<Result<unknown, RpcError>>;
	calls?: RpcCall[];
}): PeerTransport & { drop(deviceId: string): void } {
	const present = new Map(Object.entries(presentInit));
	const observers = new Set<() => void>();

	return {
		find(deviceId) {
			const clientId = present.get(deviceId);
			if (clientId === undefined) return undefined;
			return { clientId };
		},
		observe(cb) {
			observers.add(cb);
			return () => observers.delete(cb);
		},
		async rpc(target, action, input, options) {
			const call = { target, action, input, options };
			calls.push(call);
			return respond(call);
		},
		drop(deviceId: string) {
			present.delete(deviceId);
			for (const cb of observers) cb();
		},
	};
}

describe('peer<T>()', () => {
	it('builds a proxy whose dot-path becomes the rpc action arg', async () => {
		const calls: RpcCall[] = [];
		const transport = mockTransport({
			present: { mac: 42 },
			calls,
			respond: async () => Ok({ closedCount: 1 }),
		});

		const remote = peer<TestActions>(transport, 'mac');
		const result = await remote.tabs.close({ tabIds: [1] }, { timeout: 1000 });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.target).toBe(42);
		expect(calls[0]?.action).toBe('tabs.close');
		expect(calls[0]?.input).toEqual({ tabIds: [1] });
		expect(calls[0]?.options).toEqual({ timeout: 1000 });
		expect(result.error).toBeNull();
		expect(result.data).toEqual({ closedCount: 1 });
	});

	it('returns Err(PeerNotFound) without sending when peer is absent', async () => {
		const calls: RpcCall[] = [];
		const transport = mockTransport({
			present: {},
			calls,
			respond: async () => {
				throw new Error('rpc should not be called');
			},
		});

		const remote = peer<TestActions>(transport, 'ghost');
		const result = await remote.foo.bar({});
		expect(calls).toHaveLength(0);
		expect(isErr(result)).toBe(true);
		if (isErr(result) && isRpcError(result.error)) {
			expect(result.error.name).toBe('PeerNotFound');
		}
	});

	it('passes a Result through unchanged when the peer returns one', async () => {
		const transport = mockTransport({
			present: { mac: 1 },
			respond: async () => Err(RpcError.ActionNotFound({ action: 'x' }).error),
		});

		const remote = peer<TestActions>(transport, 'mac');
		const result = await remote.x();
		expect(isErr(result)).toBe(true);
		if (isErr(result) && isRpcError(result.error)) {
			expect(result.error.name).toBe('ActionNotFound');
		}
	});

	it('rejects with PeerLeft when the peer drops mid-call', async () => {
		// Hold the rpc response forever so the disconnect can race ahead.
		const transport = mockTransport({
			present: { mac: 7 },
			respond: () => new Promise<Result<unknown, RpcError>>(() => {}),
		});

		const remote = peer<TestActions>(transport, 'mac');
		const callPromise = remote.tabs.close({ tabIds: [1] });

		transport.drop('mac');

		const result = await callPromise;
		expect(isErr(result)).toBe(true);
		if (isErr(result) && isRpcError(result.error)) {
			expect(result.error.name).toBe('PeerLeft');
		}
	});
});
