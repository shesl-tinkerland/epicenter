/**
 * Renderer formatting tests for the `run --peer` path.
 *
 * Format functions return string[] (one entry per line), so tests assert
 * arrays directly instead of spying on `console.error`. Cleaner asserts,
 * no stderr machinery, and exercises exactly what the renderer prints.
 */
import { PeerMiss, RpcError } from '@epicenter/workspace';
import { describe, expect, test } from 'bun:test';
import type { AwarenessState } from '../load-config';
import { formatPeerMiss, formatRpcError } from './run';

function miss(opts: {
	peerTarget: string;
	sawPeers: boolean;
	waitMs: number;
	emptyReason?: string | null;
}) {
	return PeerMiss.PeerMiss({
		peerTarget: opts.peerTarget,
		sawPeers: opts.sawPeers,
		waitMs: opts.waitMs,
		emptyReason: opts.emptyReason ?? null,
	}).error;
}

function mockState(
	device: Partial<AwarenessState['device']> = {},
): AwarenessState {
	return {
		device: {
			id: 'mac-1',
			name: 'MacBook',
			platform: 'tauri',
			...device,
		},
	};
}

describe('formatPeerMiss', () => {
	test('peers present but no match: points at `epicenter peers`', () => {
		expect(
			formatPeerMiss(
				miss({ peerTarget: 'ghost', sawPeers: true, waitMs: 5000 }),
				undefined,
			),
		).toEqual([
			'error: no peer matches deviceId "ghost"',
			'run `epicenter peers` to see connected peers',
		]);
	});

	test('peers present + -w: scoped hint', () => {
		expect(
			formatPeerMiss(
				miss({ peerTarget: 'ghost', sawPeers: true, waitMs: 5000 }),
				'tabManager',
			),
		).toEqual([
			'error: no peer matches deviceId "ghost" in workspace tabManager',
			'run `epicenter peers -w tabManager` to see connected peers',
		]);
	});

	test('no peers seen during wait', () => {
		expect(
			formatPeerMiss(
				miss({ peerTarget: 'macbook-pro', sawPeers: false, waitMs: 5000 }),
				undefined,
			),
		).toEqual(['error: no peers seen after waiting 5000ms for "macbook-pro"']);
	});

	test('emptyReason appended when present', () => {
		expect(
			formatPeerMiss(
				miss({
					peerTarget: 'ghost',
					sawPeers: true,
					waitMs: 5000,
					emptyReason: 'not connected (auth error after 3 retries)',
				}),
				undefined,
			),
		).toEqual([
			'error: no peer matches deviceId "ghost"',
			'run `epicenter peers` to see connected peers',
			'  reason: not connected (auth error after 3 retries)',
		]);
	});
});

describe('formatRpcError', () => {
	const peer = mockState({ name: 'MacBook', platform: 'tauri' });

	test('ActionNotFound labels with device.name + platform', () => {
		expect(
			formatRpcError(
				RpcError.ActionNotFound({ action: 'tabs.closeAll' }).error,
				42,
				peer,
			),
		).toEqual(['error: ActionNotFound "tabs.closeAll" on MacBook (42, tauri)']);
	});

	test('Timeout reports ms and peer', () => {
		expect(
			formatRpcError(RpcError.Timeout({ ms: 5000 }).error, 42, peer),
		).toEqual(['error: timeout after 5000ms on MacBook (42, tauri)']);
	});

	test('PeerOffline', () => {
		expect(formatRpcError(RpcError.PeerOffline().error, 42, peer)).toEqual([
			'error: peer MacBook (42, tauri) is offline',
		]);
	});

	test('PeerNotFound surfaces the deviceId', () => {
		expect(
			formatRpcError(
				RpcError.PeerNotFound({ peer: 'macbook-pro' }).error,
				0,
				mockState(),
			),
		).toEqual(['error: no peer with deviceId "macbook-pro"']);
	});

	test('PeerLeft surfaces the deviceId', () => {
		expect(
			formatRpcError(
				RpcError.PeerLeft({ peer: 'macbook-pro' }).error,
				0,
				mockState(),
			),
		).toEqual(['error: peer "macbook-pro" disconnected before responding']);
	});

	test('ActionFailed surfaces underlying cause', () => {
		expect(
			formatRpcError(
				RpcError.ActionFailed({
					action: 'tabs.close',
					cause: new Error('Tab 99 not found'),
				}).error,
				42,
				peer,
			),
		).toEqual([
			'error: "tabs.close" failed on MacBook (42, tauri): Tab 99 not found',
		]);
	});

	test('Disconnected', () => {
		expect(formatRpcError(RpcError.Disconnected().error, 42, peer)).toEqual([
			'error: connection lost before MacBook (42, tauri) responded',
		]);
	});
});
