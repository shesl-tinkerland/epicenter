/// <reference lib="dom" />

/**
 * `system.describe`: runtime-injected meta RPC that returns the local
 * `ActionManifest` (full dot-path → ActionMeta map with input schemas).
 * Verifies:
 *   - argless `system.describe` resolves through the same RPC pipe as
 *     user actions and returns the live action manifest.
 *   - User code cannot publish a top-level `system` namespace: `attachSync`
 *     throws at bootstrap.
 *   - `sync.describePeer(deviceId)` round-trips between two attachments
 *     and returns the remote manifest.
 *   - Awareness carries no manifest: only the device descriptor.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import {
	decodeRpcPayload,
	defineMutation,
	defineQuery,
	encodeRpcRequest,
	encodeSyncStep2,
	MESSAGE_TYPE,
} from '@epicenter/sync';
import * as decoding from 'lib0/decoding';
import Type from 'typebox';
import * as Y from 'yjs';
import { attachSync } from './attach-sync.js';

// ── Minimal WebSocket stub (mirrors attach-sync.test.ts) ─────────────────

type Listener = (ev: { data: ArrayBuffer | string }) => void;

class FakeWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;

	static instances: FakeWebSocket[] = [];

	readyState = FakeWebSocket.CONNECTING;
	binaryType: 'arraybuffer' | 'blob' = 'blob';
	onopen: (() => void) | null = null;
	onclose: ((ev: { code: number; reason: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: Listener | null = null;

	readonly sent: Uint8Array[] = [];
	readonly protocols: string[];

	constructor(public readonly url: string, protocols?: string | string[]) {
		this.protocols = Array.isArray(protocols)
			? protocols
			: protocols
				? [protocols]
				: [];
		FakeWebSocket.instances.push(this);
		queueMicrotask(() => {
			this.readyState = FakeWebSocket.OPEN;
			this.onopen?.();
		});
	}

	send(data: Uint8Array | string) {
		if (typeof data === 'string') return;
		this.sent.push(data instanceof Uint8Array ? data : new Uint8Array(data));
	}

	close(code?: number, reason?: string) {
		if (
			this.readyState === FakeWebSocket.CLOSED ||
			this.readyState === FakeWebSocket.CLOSING
		)
			return;
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.({ code: code ?? 1005, reason: reason ?? '' });
	}

	addEventListener() {}
	removeEventListener() {}

	deliver(frame: Uint8Array) {
		this.onmessage?.({
			data: frame.buffer.slice(
				frame.byteOffset,
				frame.byteOffset + frame.byteLength,
			) as ArrayBuffer,
		});
	}
}

const realWebSocket = globalThis.WebSocket;

beforeEach(() => {
	FakeWebSocket.instances = [];
	(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
	return () => {
		(globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
	};
});

function peekMessageType(frame: Uint8Array): number {
	return decoding.readVarUint(decoding.createDecoder(frame));
}

function serverStep2Frame(): Uint8Array {
	const remote = new Y.Doc();
	const frame = encodeSyncStep2({ doc: remote });
	remote.destroy();
	return frame;
}

async function waitFor<T>(predicate: () => T | undefined, timeoutMs = 1000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const value = predicate();
		if (value !== undefined && value !== false) return value;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error('timeout waiting for predicate');
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('system.describe', () => {
	test('argless call returns the full local ActionManifest including input schemas', async () => {
		const ydoc = new Y.Doc({ guid: 'sd-known' });
		const sync = attachSync(ydoc, {
			url: `ws://x/${ydoc.guid}`,
			actions: {
				tabs: {
					close: defineMutation({
						title: 'Close Tabs',
						description: 'Close one or more browser tabs',
						input: Type.Object({ tabIds: Type.Array(Type.Number()) }),
						handler: () => ({ closedCount: 0 }),
					}),
				},
				ping: defineQuery({ handler: () => 'pong' }),
			},
		});

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		await waitFor(() => ws.readyState === FakeWebSocket.OPEN);
		ws.deliver(serverStep2Frame());
		await sync.whenConnected;

		const seenBefore = ws.sent.length;
		ws.deliver(
			encodeRpcRequest({
				requestId: 1,
				targetClientId: ydoc.clientID,
				requesterClientId: 9999,
				action: 'system.describe',
				input: undefined,
			}),
		);

		const response = await waitFor<Uint8Array>(() => {
			for (let i = seenBefore; i < ws.sent.length; i++) {
				const frame = ws.sent[i]!;
				if (peekMessageType(frame) === MESSAGE_TYPE.RPC) return frame;
			}
			return undefined;
		}, 500);

		const dec = decoding.createDecoder(response);
		decoding.readVarUint(dec);
		const parsed = decodeRpcPayload(dec);
		if (parsed.type !== 'response') throw new Error('unreachable');
		expect(parsed.result.error).toBeNull();

		const manifest = parsed.result.data as Record<
			string,
			{ type: string; title?: string; description?: string; input?: unknown }
		>;
		expect(Object.keys(manifest).sort()).toEqual(['ping', 'tabs.close']);
		expect(manifest['tabs.close']!.type).toBe('mutation');
		expect(manifest['tabs.close']!.title).toBe('Close Tabs');
		expect(manifest['tabs.close']!.input).toMatchObject({
			type: 'object',
			properties: { tabIds: { type: 'array' } },
		});
		expect(manifest['ping']!.type).toBe('query');

		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('attaching with a top-level `system` user namespace throws at attachSync', () => {
		const ydoc = new Y.Doc({ guid: 'sd-reserved' });
		expect(() =>
			attachSync(ydoc, {
				url: `ws://x/${ydoc.guid}`,
				device: { id: 'd', name: 'd', platform: 'web' },
				actions: {
					system: {
						foo: defineQuery({ handler: () => 'no' }),
					},
				},
			}),
		).toThrow(/system\.\*/);
		ydoc.destroy();
	});

	test('awareness carries device identity only: no offers/manifest field', async () => {
		const ydoc = new Y.Doc({ guid: 'sd-awareness' });
		const sync = attachSync(ydoc, {
			url: `ws://x/${ydoc.guid}`,
			device: { id: 'self', name: 'self', platform: 'web' },
			actions: {
				ping: defineQuery({ handler: () => 'pong' }),
			},
		});

		const local = sync.raw.awareness?.getLocalState() as {
			device?: Record<string, unknown>;
		} | null;
		expect(local?.device).toEqual({
			id: 'self',
			name: 'self',
			platform: 'web',
		});
		expect(local?.device).not.toHaveProperty('offers');

		ydoc.destroy();
		await sync.whenDisposed;
	});
});

describe('sync.describePeer(deviceId)', () => {
	test('round-trips between two attachments via system.describe', async () => {
		// Two ydocs sharing one in-memory wire. The "remote" ydoc registers a
		// peer awareness state on the "local" sync directly; for RPC we wire
		// the local sync's WebSocket onmessage to the remote sync's outbound
		// queue and vice versa.
		const localDoc = new Y.Doc({ guid: 'ps-local' });
		const remoteDoc = new Y.Doc({ guid: 'ps-remote' });

		const localSync = attachSync(localDoc, {
			url: `ws://x/${localDoc.guid}`,
			device: { id: 'local', name: 'local', platform: 'web' },
		});
		const remoteSync = attachSync(remoteDoc, {
			url: `ws://x/${remoteDoc.guid}`,
			device: { id: 'remote', name: 'remote', platform: 'web' },
			actions: {
				tabs: {
					close: defineMutation({
						input: Type.Object({ tabIds: Type.Array(Type.Number()) }),
						handler: () => ({ closedCount: 0 }),
					}),
				},
			},
		});

		const localWs = await waitFor(() => FakeWebSocket.instances[0]);
		const remoteWs = await waitFor(() => FakeWebSocket.instances[1]);
		await waitFor(() => localWs.readyState === FakeWebSocket.OPEN);
		await waitFor(() => remoteWs.readyState === FakeWebSocket.OPEN);
		localWs.deliver(serverStep2Frame());
		remoteWs.deliver(serverStep2Frame());
		await localSync.whenConnected;
		await remoteSync.whenConnected;

		// Cross-wire RPC: when local sends an RPC frame, deliver it to remote
		// (rewriting requesterClientId so the remote responds with a frame
		// the local pipe can route back).
		const REMOTE_FAKE_CLIENT = 42;
		// Inject a fake "remote" peer into local awareness so describePeer can
		// find a clientId to dispatch against.
		localSync.raw.awareness!.getStates().set(REMOTE_FAKE_CLIENT, {
			device: { id: 'remote', name: 'remote', platform: 'web' },
		});

		// When local sync sends an RPC request, rewrite it as if it came from
		// the remote-fake clientId and deliver to the remote sync. When remote
		// sync sends an RPC response back, deliver to local sync.
		const originalLocalSend = localWs.send.bind(localWs);
		const originalRemoteSend = remoteWs.send.bind(remoteWs);

		localWs.send = (data: Uint8Array | string) => {
			originalLocalSend(data);
			if (typeof data === 'string') return;
			const frame = data instanceof Uint8Array ? data : new Uint8Array(data);
			if (peekMessageType(frame) !== MESSAGE_TYPE.RPC) return;
			// Forward to remote ydoc as a request.
			remoteWs.deliver(frame);
		};
		remoteWs.send = (data: Uint8Array | string) => {
			originalRemoteSend(data);
			if (typeof data === 'string') return;
			const frame = data instanceof Uint8Array ? data : new Uint8Array(data);
			if (peekMessageType(frame) !== MESSAGE_TYPE.RPC) return;
			// Forward response to local ydoc.
			localWs.deliver(frame);
		};

		const result = await localSync.describePeer('remote');
		expect(result.error).toBeNull();
		const manifest = result.data!;
		expect(Object.keys(manifest).sort()).toEqual(['tabs.close']);
		expect(manifest['tabs.close']!.input).toMatchObject({ type: 'object' });

		localDoc.destroy();
		remoteDoc.destroy();
		await localSync.whenDisposed;
		await remoteSync.whenDisposed;
	});
});
