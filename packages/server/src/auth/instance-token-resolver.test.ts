/**
 * Instance-token resolver unit tests.
 *
 * The resolver is the self-host single-user bearer credential source: it reads
 * `Authorization: Bearer <token>` off the request and resolves the box's single
 * owner on an exact, constant-time match. These tests pin the `Result` arm it
 * returns for each input; the auth wrappers' HTTP/WebSocket failure shaping is
 * covered generically in `require-auth.test.ts` and `oauth-resource.test.ts`.
 */

import { expect, test } from 'bun:test';
import { AuthUser, asUserId } from '@epicenter/auth';
import type { Context } from 'hono';
import type { Env } from '../types.js';
import { createInstanceTokenResolver } from './instance-token-resolver.js';

const TOKEN = 'instance-token-0123456789abcdef0123456789abcdef';
const OWNER = AuthUser.assert({
	id: asUserId('self-host-owner'),
	email: 'owner@self-host.invalid',
});

/** Minimal context exposing only what the resolver reads: the auth header. */
function contextWithAuthorization(value: string | null): Context<Env> {
	return {
		req: {
			header: (name: string) =>
				name.toLowerCase() === 'authorization'
					? (value ?? undefined)
					: undefined,
		},
	} as unknown as Context<Env>;
}

const resolve = createInstanceTokenResolver({ token: TOKEN, user: OWNER });

test('resolves the configured owner for an exact bearer match', async () => {
	const { data, error } = await resolve(
		contextWithAuthorization(`Bearer ${TOKEN}`),
	);
	expect(error).toBeNull();
	expect(data).toEqual(OWNER);
});

test('rejects a mismatched token with InvalidToken', async () => {
	const { data, error } = await resolve(
		contextWithAuthorization(`Bearer ${TOKEN}-wrong`),
	);
	expect(data).toBeNull();
	expect(error?.name).toBe('InvalidToken');
});

test('rejects a token that is only a prefix of the configured token', async () => {
	const { error } = await resolve(
		contextWithAuthorization(`Bearer ${TOKEN.slice(0, -1)}`),
	);
	expect(error?.name).toBe('InvalidToken');
});

test('rejects a missing Authorization header with InvalidToken', async () => {
	const { error } = await resolve(contextWithAuthorization(null));
	expect(error?.name).toBe('InvalidToken');
});

test('rejects a non-bearer scheme with InvalidToken', async () => {
	const { error } = await resolve(contextWithAuthorization(`Basic ${TOKEN}`));
	expect(error?.name).toBe('InvalidToken');
});
