/**
 * Better Auth Cookie Config Tests
 *
 * Verifies that the API auth factory chooses browser-compatible cookie
 * attributes for local development while preserving the production cookie
 * scope used by api.epicenter.so.
 *
 * Key behaviors:
 * - Localhost uses host-only, Lax, non-secure cookies
 * - A deployed origin without a cross-subdomain domain uses host-only,
 *   SameSite=None, Secure cookies (the self-host default)
 * - A deployed origin given a cross-subdomain domain (Epicenter cloud passes
 *   .epicenter.so) scopes cookies to that domain
 */

import { expect, test } from 'bun:test';
import type { BetterAuthOptions } from 'better-auth';
import { getCookies } from 'better-auth/cookies';
import { createCookieAdvancedConfig } from './cookie-config.js';

test('localhost cookies are host-only, Lax, and non-secure', () => {
	const cookie = sessionTokenCookie('http://localhost:8787');

	expect(cookie.name).toBe('better-auth.session_token');
	expect(cookie.attributes.secure).toBe(false);
	expect(cookie.attributes.sameSite).toBe('lax');
	expect('domain' in cookie.attributes).toBe(false);
});

test('loopback cookies use localhost-compatible attributes', () => {
	const cookie = sessionTokenCookie('http://127.0.0.1:8787');

	expect(cookie.name).toBe('better-auth.session_token');
	expect(cookie.attributes.secure).toBe(false);
	expect(cookie.attributes.sameSite).toBe('lax');
	expect('domain' in cookie.attributes).toBe(false);
});

test('IPv6 localhost cookies use localhost-compatible attributes', () => {
	const cookie = sessionTokenCookie('http://[::1]:8787');

	expect(cookie.name).toBe('better-auth.session_token');
	expect(cookie.attributes.secure).toBe(false);
	expect(cookie.attributes.sameSite).toBe('lax');
	expect('domain' in cookie.attributes).toBe(false);
});

test('a deployed origin without a cross-subdomain domain uses host-only secure cookies', () => {
	const cookie = sessionTokenCookie('https://team.example.com');

	expect(cookie.name).toBe('__Secure-better-auth.session_token');
	expect(cookie.attributes.secure).toBe(true);
	expect(cookie.attributes.sameSite).toBe('none');
	expect('domain' in cookie.attributes).toBe(false);
});

test('a deployed origin given a cross-subdomain domain scopes cookies to it', () => {
	const cookie = sessionTokenCookie('https://api.epicenter.so', '.epicenter.so');

	expect(cookie.name).toBe('__Secure-better-auth.session_token');
	expect(cookie.attributes.secure).toBe(true);
	expect(cookie.attributes.sameSite).toBe('none');
	expect(cookie.attributes.domain).toBe('.epicenter.so');
});

function sessionTokenCookie(baseURL: string, crossSubDomainDomain?: string) {
	const options = {
		baseURL,
		basePath: '/auth',
		advanced: createCookieAdvancedConfig(baseURL, crossSubDomainDomain),
	} satisfies BetterAuthOptions;
	return getCookies(options).sessionToken;
}
