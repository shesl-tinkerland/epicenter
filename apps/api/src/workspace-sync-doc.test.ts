/**
 * Workspace Sync Doc Boundary Tests
 *
 * Verifies the product-shaped Cloud sync target resolver. The Hono route owns
 * Better Auth organization membership, validates public route ids, and passes
 * an opaque room name to the policy-free sync plane.
 *
 * Key behaviors:
 * - Non-members are rejected before room resolution succeeds.
 * - Members can open root and arbitrary valid app-owned docs.
 * - Invalid app/doc ids are rejected before membership checks.
 * - Room names are encoded by one builder and cannot collide across parts.
 * - Room and SyncEngine modules do not import host auth or billing code.
 */

import { expect, test } from 'bun:test';
import type { AuthUser } from '@epicenter/auth';
import {
	buildWorkspaceSyncDocRoomName,
	resolveAuthorizedWorkspaceSyncDoc,
} from './workspace-sync-doc.js';

const user = {
	id: 'user_1',
	email: 'user@example.com',
} satisfies AuthUser;

function setup(options: { member?: boolean } = {}) {
	const membershipChecks: Array<{ userId: string; workspaceId: string }> = [];
	const checkWorkspaceMembership = async (params: {
		userId: string;
		workspaceId: string;
	}) => {
		membershipChecks.push(params);
		return options.member ?? true;
	};

	return { checkWorkspaceMembership, membershipChecks };
}

test('resolver rejects non-members before returning a room name', async () => {
	const { checkWorkspaceMembership, membershipChecks } = setup({
		member: false,
	});

	const result = await resolveAuthorizedWorkspaceSyncDoc({
		user,
		workspaceId: 'workspace_1',
		appId: 'whispering',
		docId: 'root',
		checkWorkspaceMembership,
	});

	expect(result.error).toEqual({
		name: 'WorkspaceForbidden',
		message: 'User is not a member of this workspace',
		status: 403,
	});
	expect(result.data).toBeUndefined();
	expect(membershipChecks).toEqual([
		{ userId: 'user_1', workspaceId: 'workspace_1' },
	]);
});

test('resolver accepts members and builds the workspace sync doc room name', async () => {
	const { checkWorkspaceMembership } = setup({ member: true });

	const result = await resolveAuthorizedWorkspaceSyncDoc({
		user,
		workspaceId: 'workspace_1',
		appId: 'whispering',
		docId: 'root',
		checkWorkspaceMembership,
	});

	expect(result.error).toBeUndefined();
	expect(result.data).toEqual({
		workspaceId: 'workspace_1',
		appId: 'whispering',
		docId: 'root',
		roomName: 'v1:workspace:workspace_1:app:whispering:doc:root',
		syncDocResourceName: 'workspace_1/whispering/root',
	});
});

test('resolver treats root as a normal valid doc id', async () => {
	const { checkWorkspaceMembership } = setup();

	const root = await resolveAuthorizedWorkspaceSyncDoc({
		user,
		workspaceId: 'workspace_1',
		appId: 'whispering',
		docId: 'root',
		checkWorkspaceMembership,
	});
	const child = await resolveAuthorizedWorkspaceSyncDoc({
		user,
		workspaceId: 'workspace_1',
		appId: 'whispering',
		docId: 'recording_rec_123',
		checkWorkspaceMembership,
	});

	expect(root.data?.docId).toBe('root');
	expect(child.data?.docId).toBe('recording_rec_123');
	expect(root.data?.roomName).toBe(
		'v1:workspace:workspace_1:app:whispering:doc:root',
	);
	expect(child.data?.roomName).toBe(
		'v1:workspace:workspace_1:app:whispering:doc:recording_rec_123',
	);
});

test('resolver rejects invalid workspaceId, appId, and docId before membership checks', async () => {
	const { checkWorkspaceMembership, membershipChecks } = setup();

	const invalidWorkspace = await resolveAuthorizedWorkspaceSyncDoc({
		user,
		workspaceId: 'bad/workspace',
		appId: 'whispering',
		docId: 'root',
		checkWorkspaceMembership,
	});
	const invalidApp = await resolveAuthorizedWorkspaceSyncDoc({
		user,
		workspaceId: 'workspace_1',
		appId: 'bad/app',
		docId: 'root',
		checkWorkspaceMembership,
	});
	const invalidDoc = await resolveAuthorizedWorkspaceSyncDoc({
		user,
		workspaceId: 'workspace_1',
		appId: 'whispering',
		docId: 'bad:doc',
		checkWorkspaceMembership,
	});

	expect(invalidWorkspace.error).toMatchObject({
		name: 'InvalidWorkspaceSyncDoc',
		message: 'Invalid workspaceId',
		status: 400,
	});
	expect(invalidApp.error).toMatchObject({
		name: 'InvalidWorkspaceSyncDoc',
		message: 'Invalid appId',
		status: 400,
	});
	expect(invalidDoc.error).toMatchObject({
		name: 'InvalidWorkspaceSyncDoc',
		message: 'Invalid docId',
		status: 400,
	});
	expect(membershipChecks).toEqual([]);
});

test('room name builder encodes parts so delimiter collisions cannot merge identities', () => {
	const first = buildWorkspaceSyncDocRoomName({
		workspaceId: 'a:b',
		appId: 'c',
		docId: 'd',
	});
	const second = buildWorkspaceSyncDocRoomName({
		workspaceId: 'a',
		appId: 'b:c',
		docId: 'd',
	});

	expect(first).toBe('v1:workspace:a%3Ab:app:c:doc:d');
	expect(second).toBe('v1:workspace:a:app:b%3Ac:doc:d');
	expect(first).not.toBe(second);
});

test('Room and SyncEngine source do not import host auth or billing code', async () => {
	const syncEngineSource = await Bun.file(
		new URL('./sync-engine.ts', import.meta.url),
	).text();
	const roomSource = await Bun.file(
		new URL('./room.ts', import.meta.url),
	).text();

	for (const source of [syncEngineSource, roomSource]) {
		expect(source).not.toMatch(/^import .*better-auth/m);
		expect(source).not.toMatch(/^import .*auth\//m);
		expect(source).not.toMatch(/^import .*autumn/m);
		expect(source).not.toMatch(/^import .*billing/m);
	}
});
