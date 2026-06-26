/**
 * Instance-token session-path integration test.
 *
 * Drives the real `/api/session` surface (cookie-or-bearer auth + the personal
 * ownership boundary + the route) with the instance-token resolver injected, the
 * way a solo self-host box wires it (ADR-0072). No Better Auth server is needed:
 * a solo box has no OAuth, so `getSession` always misses and the cookie-or-bearer
 * middleware falls through to the bearer resolver.
 *
 * This proves the contract the client's boot probe relies on end to end: the
 * minted bearer resolves the box's single owner and its `personal()` partition
 * (200), and any other credential is a 401 with the standard OAuth challenge.
 * The resolver's per-input `Result` arms are pinned in `instance-token-resolver
 * .test.ts`; this pins the HTTP projection through the actual mounts.
 */

import { expect, test } from 'bun:test';
import { AuthUser, asUserId } from '@epicenter/auth';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import { Hono } from 'hono';
import { personal } from '../ownership.js';
import { mountSessionApp } from '../routes/session.js';
import type { Env } from '../types.js';
import { createInstanceTokenResolver } from './instance-token-resolver.js';

const TOKEN = 'instance-token-0123456789abcdef0123456789abcdef';
const OWNER = AuthUser.assert({
	id: asUserId('self-host'),
	email: 'owner@self-host.local',
});

/**
 * The solo-box session surface: a stub `auth` whose `getSession` always misses
 * (no Better Auth on a bearer-only box), the instance-token resolver as the
 * bearer fallback, and the real session mount over `personal()` ownership.
 */
function createSoloSessionApp() {
	const app = new Hono<Env>();
	app.use('*', async (c, next) => {
		c.set('auth', {
			api: { getSession: async () => null },
		} as unknown as Env['Variables']['auth']);
		c.set(
			'resolveUser',
			createInstanceTokenResolver({ token: TOKEN, user: OWNER }),
		);
		await next();
	});
	mountSessionApp(app, { ownership: personal() });
	return app;
}

test('a valid instance-token bearer resolves the box owner and its partition', async () => {
	const app = createSoloSessionApp();

	const res = await app.request(API_ROUTES.session.pattern, {
		headers: { authorization: `Bearer ${TOKEN}` },
	});

	expect(res.status).toBe(200);
	const body = (await res.json()) as {
		user: { id: string; email: string };
		ownerId: string;
	};
	expect(body).toEqual({
		user: { id: OWNER.id, email: OWNER.email },
		// personal() partitions by the owner id, so the box is its own owner.
		ownerId: OWNER.id,
	});
});

test('a mismatched bearer is rejected with 401 InvalidToken', async () => {
	const app = createSoloSessionApp();

	const res = await app.request(API_ROUTES.session.pattern, {
		headers: { authorization: `Bearer ${TOKEN}-wrong` },
	});

	expect(res.status).toBe(401);
	expect(res.headers.get('WWW-Authenticate')).toBe(
		'Bearer error="invalid_token"',
	);
	expect(((await res.json()) as { name: string }).name).toBe('InvalidToken');
});

test('a request with no Authorization header is rejected with 401 InvalidToken', async () => {
	const app = createSoloSessionApp();

	const res = await app.request(API_ROUTES.session.pattern);

	expect(res.status).toBe(401);
	expect(((await res.json()) as { name: string }).name).toBe('InvalidToken');
});
