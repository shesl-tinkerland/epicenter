/**
 * OAuth provider SSOT tests.
 *
 * `configuredSocialProviders` is what `createAuth` registers; a provider counts
 * only when BOTH its id and secret are set. `incompleteSocialProviders` is the
 * half-pair guard the self-host entry fails boot on, so a typo'd secret can no
 * longer be silently dropped (which used to flip an intended wiki into a solo
 * box). These pin both directions over the same provider table.
 */

import { expect, test } from 'bun:test';
import {
	configuredSocialProviders,
	incompleteSocialProviders,
} from './social-providers.js';

test('a complete pair is registered; a half pair is dropped', () => {
	expect(
		configuredSocialProviders({
			GOOGLE_CLIENT_ID: 'id',
			GOOGLE_CLIENT_SECRET: 'secret',
			GITHUB_CLIENT_ID: 'gh', // no secret -> not configured
		}),
	).toEqual({ google: { clientId: 'id', clientSecret: 'secret' } });
});

test('no providers configured yields an empty set', () => {
	expect(configuredSocialProviders({})).toEqual({});
});

test('both providers configured registers both', () => {
	expect(
		configuredSocialProviders({
			GOOGLE_CLIENT_ID: 'g',
			GOOGLE_CLIENT_SECRET: 'gs',
			GITHUB_CLIENT_ID: 'h',
			GITHUB_CLIENT_SECRET: 'hs',
		}),
	).toEqual({
		google: { clientId: 'g', clientSecret: 'gs' },
		github: { clientId: 'h', clientSecret: 'hs' },
	});
});

test('incompleteSocialProviders flags a provider with exactly one of id/secret', () => {
	expect(incompleteSocialProviders({ GOOGLE_CLIENT_ID: 'id' })).toEqual([
		'google',
	]);
	expect(incompleteSocialProviders({ GITHUB_CLIENT_SECRET: 'secret' })).toEqual([
		'github',
	]);
	expect(
		incompleteSocialProviders({
			GOOGLE_CLIENT_ID: 'id',
			GITHUB_CLIENT_SECRET: 'secret',
		}),
	).toEqual(['google', 'github']);
});

test('incompleteSocialProviders is empty for complete or fully-absent pairs', () => {
	expect(
		incompleteSocialProviders({
			GOOGLE_CLIENT_ID: 'id',
			GOOGLE_CLIENT_SECRET: 'secret',
		}),
	).toEqual([]);
	expect(incompleteSocialProviders({})).toEqual([]);
});
