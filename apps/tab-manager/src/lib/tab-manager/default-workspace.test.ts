/**
 * Tab Manager Default Workspace Tests
 *
 * Verifies that Tab Manager resolves the product Workspace from
 * `/api/workspaces` when Cloud collaboration can attach, not once during
 * module readiness.
 *
 * Key behaviors:
 * - Signed-out resolution does not call the Workspace API.
 * - A later signed-in resolution returns the server default.
 */

import { expect, test } from 'bun:test';
import type { AuthState, LocalIdentity } from '@epicenter/auth';
import { resolveDefaultWorkspaceId } from './default-workspace.js';

const localIdentity: LocalIdentity = {
	subject: 'user_1',
	keyring: [
		{
			version: 1,
			subjectKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
		},
	],
};

test('default Workspace resolution retries after signed-out startup', async () => {
	let state: AuthState = { status: 'signed-out' };
	const fetches: string[] = [];
	const auth = {
		get state() {
			return state;
		},
		async fetch(input: Request | string | URL) {
			fetches.push(String(input));
			return Response.json({ defaultWorkspaceId: 'ws_after_sign_in' });
		},
	};

	await expect(resolveDefaultWorkspaceId(auth)).resolves.toBeUndefined();
	expect(fetches).toEqual([]);

	state = {
		status: 'signed-in',
		localIdentity,
	};

	await expect(resolveDefaultWorkspaceId(auth)).resolves.toBe(
		'ws_after_sign_in',
	);
	expect(fetches).toEqual(['/api/workspaces']);
});
