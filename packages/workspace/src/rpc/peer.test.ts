/**
 * `peer<T>()` unit tests — proxy mechanics + first-match resolution +
 * disconnect short-circuit. Tests use a mock `SyncAttachment` — no real
 * Y.Doc, no real WebSocket, no real awareness. The peer-resolution logic
 * itself is covered in attach-sync.test.ts (presence section).
 */

import { describe, expect, it } from 'bun:test';
import Type from 'typebox';
import { Err, Ok, isErr } from 'wellcrafted/result';
import type { Result } from 'wellcrafted/result';
import { RpcError, isRpcError } from '@epicenter/sync';
import {
	PeerMiss,
	type FoundPeer,
	type SyncAttachment,
} from '@epicenter/workspace';
import { defineMutation, defineQuery } from '../shared/actions.js';
import { peer } from './peer.js';

// Reference action shape used to type the test proxy. Handlers are never
// invoked here — only the *type* flows through `peer<typeof TestActions>`.
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
 * Mock SyncAttachment — keeps a mutable `present` map of deviceId→clientId
 * so tests can drop a peer mid-call by mutating it and firing observers.
 * Only `find`, `observe`, and `rpc` are populated; tests never touch the
 * connection-lifecycle methods.
 */
function mockSync(opts: {
	present: Record<string, number>;
	respond: (call: RpcCall) => Promise<Result<unknown, RpcError>>;
	calls?: RpcCall[];
}): SyncAttachment & { drop(deviceId: string): void } {
	const present = new Map(Object.entries(opts.present));
	const observers = new Set<() => void>();
	const calls = opts.calls ?? [];

	return {
		// peer-discovery surface
		find(deviceId): FoundPeer | undefined {
			const clientId = present.get(deviceId);
			if (clientId === undefined) return undefined;
			return {
				clientId,
				state: {
					device: {
						id: deviceId,
						name: deviceId,
						platform: 'web',
					},
				},
			};
		},
		observe(cb) {
			observers.add(cb);
			return () => observers.delete(cb);
		},
		async waitForPeer(deviceId, { timeoutMs }) {
			const clientId = present.get(deviceId);
			if (clientId !== undefined) {
				return Ok({
					clientId,
					state: {
						device: { id: deviceId, name: deviceId, platform: 'web' },
					},
				});
			}
			return PeerMiss.PeerMiss({
				peerTarget: deviceId,
				sawPeers: present.size > 0,
				waitMs: timeoutMs,
				emptyReason: null,
			});
		},
		// rpc dispatch
		async rpc(target, action, input, options) {
			const call = { target, action, input, options };
			calls.push(call);
			return opts.respond(call);
		},
		// transport surface — irrelevant for these tests, but the type wants them
		whenConnected: Promise.resolve(),
		whenDisposed: Promise.resolve(),
		status: { phase: 'offline' as const },
		onStatusChange: () => () => {},
		goOffline: () => {},
		reconnect: () => {},
		peers: () => new Map(),
		raw: { awareness: null },
		// test helper
		drop(deviceId: string) {
			present.delete(deviceId);
			for (const cb of observers) cb();
		},
	};
}

describe('peer<T>()', () => {
	it('builds a proxy whose dot-path becomes the rpc action arg', async () => {
		const calls: RpcCall[] = [];
		const sync = mockSync({
			present: { mac: 42 },
			calls,
			respond: async () => Ok({ closedCount: 1 }),
		});

		const remote = peer<TestActions>(sync, 'mac');
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
		const sync = mockSync({
			present: {},
			calls,
			respond: async () => {
				throw new Error('rpc should not be called');
			},
		});

		const remote = peer<TestActions>(sync, 'ghost');
		const result = await remote.foo.bar({});
		expect(calls).toHaveLength(0);
		expect(isErr(result)).toBe(true);
		if (isErr(result) && isRpcError(result.error)) {
			expect(result.error.name).toBe('PeerNotFound');
		}
	});

	it('passes a Result through unchanged when the peer returns one', async () => {
		const sync = mockSync({
			present: { mac: 1 },
			respond: async () => Err(RpcError.ActionNotFound({ action: 'x' }).error),
		});

		const remote = peer<TestActions>(sync, 'mac');
		const result = await remote.x();
		expect(isErr(result)).toBe(true);
		if (isErr(result) && isRpcError(result.error)) {
			expect(result.error.name).toBe('ActionNotFound');
		}
	});

	it('rejects with PeerLeft when the peer drops mid-call', async () => {
		// Hold the rpc response forever so the disconnect can race ahead.
		const sync = mockSync({
			present: { mac: 7 },
			respond: () => new Promise<Result<unknown, RpcError>>(() => {}),
		});

		const remote = peer<TestActions>(sync, 'mac');
		const callPromise = remote.tabs.close({ tabIds: [1] });

		sync.drop('mac');

		const result = await callPromise;
		expect(isErr(result)).toBe(true);
		if (isErr(result) && isRpcError(result.error)) {
			expect(result.error.name).toBe('PeerLeft');
		}
	});
});
