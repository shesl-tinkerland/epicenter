/**
 * Startup tests for `startProjectMounts`.
 *
 * Pin three contracts:
 * - happy path opens every configured mount in parallel and returns the
 *   started mounts
 * - if any sibling `open(ctx)` rejects, all successfully opened runtimes are
 *   asyncDispose'd before the structured error propagates
 * - invalid mount names fail before any mount opens
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { asOwnerId } from '@epicenter/constants/identity';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { Mount, MountContext } from '../daemon/define-mount.js';
import type { DaemonRuntime } from '../daemon/types.js';

import type { WorkspaceAuthClient } from './auth-client.js';
import { startProjectMounts } from './start-project-mounts.js';

let projectDir: string;

beforeEach(() => {
	projectDir = mkdtempSync(join(tmpdir(), 'workspace-apps-start-'));
});

afterEach(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

function disposeMarkerPath(mount: string): string {
	return join(projectDir, `${mount}.disposed`);
}

function stubAuthClient(): WorkspaceAuthClient {
	return {
		state: {
			status: 'signed-in',
			ownerId: asOwnerId('test-user'),
			keyring: [] as never,
		},
		openWebSocket: () => Promise.resolve({} as WebSocket),
		onStateChange: () => () => {},
	};
}

function testRuntime(
	onDispose: () => void | Promise<void> = () => {},
): DaemonRuntime {
	return {
		collaboration: {} as DaemonRuntime['collaboration'],
		async [Symbol.asyncDispose]() {
			await onDispose();
		},
	};
}

describe('startProjectMounts', () => {
	test('opens every configured mount and returns the started mounts', async () => {
		const mounts: Mount[] = [
			{
				name: 'alpha',
				async open(ctx: MountContext) {
					expect(ctx.mount).toBe('alpha');
					return testRuntime();
				},
			},
			{
				name: 'beta',
				async open(ctx: MountContext) {
					expect(ctx.mount).toBe('beta');
					return testRuntime();
				},
			},
		];

		const result = await startProjectMounts({
			projectDir,
			auth: stubAuthClient(),
			mounts,
		});
		const data = expectOk(result);
		const names = data
			.map((entry) => entry.mount)
			.slice()
			.sort();
		expect(names).toEqual(['alpha', 'beta']);
	});

	test('disposes successfully opened runtimes when a sibling open fails', async () => {
		const goodMarker = disposeMarkerPath('good');
		const mounts: Mount[] = [
			{
				name: 'good',
				async open() {
					return testRuntime(() => writeFileSync(goodMarker, 'disposed'));
				},
			},
			{
				name: 'bad',
				async open() {
					throw new Error('boom');
				},
			},
		];

		const result = await startProjectMounts({
			projectDir,
			auth: stubAuthClient(),
			mounts,
		});
		const error = expectErr(result);
		expect(error.name).toBe('MountOpenFailed');
		expect(error).toMatchObject({ mount: 'bad' });

		expect(await Bun.file(goodMarker).exists()).toBe(true);
	});

	test('rejects invalid mount names before opening mounts', async () => {
		const marker = disposeMarkerPath('invalid');
		const mounts: Mount[] = [
			{
				name: '__proto__',
				async open() {
					writeFileSync(marker, 'opened');
					return testRuntime();
				},
			},
		];

		const result = await startProjectMounts({
			projectDir,
			auth: stubAuthClient(),
			mounts,
		});
		const error = expectErr(result);
		expect(error).toMatchObject({
			name: 'MountRejected',
			mount: '__proto__',
			reason: 'invalid',
		});
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	test('returns an empty result when no mounts are configured', async () => {
		const result = await startProjectMounts({
			projectDir,
			auth: stubAuthClient(),
			mounts: [],
		});
		const data = expectOk(result);
		expect(data).toEqual([]);
	});

	test('refuses to open mounts when machine auth is signed out', async () => {
		const mounts: Mount[] = [
			{
				name: 'alpha',
				async open() {
					throw new Error('must not open');
				},
			},
		];

		const result = await startProjectMounts({
			projectDir,
			auth: { state: { status: 'signed-out' } } as WorkspaceAuthClient,
			mounts,
		});
		const error = expectErr(result);
		expect(error.name).toBe('WorkspaceAuthSignedOut');
	});
});
