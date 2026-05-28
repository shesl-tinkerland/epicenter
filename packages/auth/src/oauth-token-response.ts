import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { OAuthTokenGrant } from './auth-types.js';

/**
 * Shape-level failures rejecting an OAuth token endpoint payload before it
 * becomes a persisted grant. Each variant maps to one invariant in
 * {@link parseOAuthTokenGrant}: missing or non-string fields, a wrong
 * `token_type`, or a non-object payload.
 */
export const OAuthTokenResponseError = defineErrors({
	InvalidResponse: () => ({
		message: 'Expected OAuth token response to be an object.',
	}),
	InvalidTokenType: ({ tokenType }: { tokenType: unknown }) => ({
		message: `Expected token_type to be bearer, got ${JSON.stringify(tokenType)}.`,
		tokenType,
	}),
	MissingAccessToken: () => ({
		message: 'Expected access_token to be a string.',
	}),
	MissingRefreshToken: () => ({
		message: 'Expected refresh_token to be a string.',
	}),
	MissingExpiresIn: () => ({
		message: 'Expected expires_in to be a positive finite number.',
	}),
});

export type OAuthTokenResponseError = InferErrors<
	typeof OAuthTokenResponseError
>;

/**
 * Normalize an OAuth token endpoint payload into Epicenter's persisted grant.
 *
 * Use this immediately after authorization-code and refresh-token exchanges.
 * It enforces the client-side token invariant before anything is written to
 * storage: grants must be bearer tokens with an access token, a refresh token
 * (or refresh fallback during rotation), and a positive `expires_in` value that
 * becomes an absolute refresh hint.
 *
 * `fallbackRefreshToken` is only for refresh-token rotation. Some OAuth servers
 * omit `refresh_token` when the existing refresh token remains valid; initial
 * authorization-code exchanges must not pass a fallback.
 */
export function parseOAuthTokenGrant(
	payload: unknown,
	{
		now,
		fallbackRefreshToken,
	}: {
		now: () => number;
		fallbackRefreshToken?: string;
	},
): Result<OAuthTokenGrant, OAuthTokenResponseError> {
	if (
		payload === null ||
		typeof payload !== 'object' ||
		Array.isArray(payload)
	) {
		return OAuthTokenResponseError.InvalidResponse();
	}
	const record = payload as Record<string, unknown>;
	const tokenType = record['token_type'];
	if (typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer') {
		return OAuthTokenResponseError.InvalidTokenType({ tokenType });
	}

	const accessToken = record['access_token'];
	if (typeof accessToken !== 'string') {
		return OAuthTokenResponseError.MissingAccessToken();
	}

	const refreshToken = record['refresh_token'];
	if (refreshToken != null && typeof refreshToken !== 'string') {
		return OAuthTokenResponseError.MissingRefreshToken();
	}
	const nextRefreshToken = refreshToken ?? fallbackRefreshToken;
	if (nextRefreshToken === undefined) {
		return OAuthTokenResponseError.MissingRefreshToken();
	}

	const expiresIn = record['expires_in'];
	if (
		typeof expiresIn !== 'number' ||
		!Number.isFinite(expiresIn) ||
		expiresIn <= 0
	) {
		return OAuthTokenResponseError.MissingExpiresIn();
	}

	return Ok({
		accessToken,
		refreshToken: nextRefreshToken,
		accessTokenExpiresAt: now() + expiresIn * 1000,
	});
}
