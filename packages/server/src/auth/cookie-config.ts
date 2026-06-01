import type { BetterAuthOptions } from 'better-auth';

/**
 * Choose Better Auth cookie transport settings for the current API origin.
 *
 * Use this from the auth server factory, not from client code. Localhost must
 * use host-only, non-secure Lax cookies so the Vite auth proxy can work during
 * development. Deployed API origins use secure `SameSite=None` cookies so
 * browser apps can send them cross-origin while app clients stay on bearer
 * tokens for resource access.
 *
 * `crossSubDomainDomain` is the registrable domain a deployment serving
 * multiple subdomains shares sessions across (Epicenter cloud passes
 * `.epicenter.so` so `app.` and `api.` share a session). It is supplied by the
 * deployment, never hardcoded here: a single-origin self-host passes nothing
 * and gets host-only cookies that actually apply to its own host, instead of
 * cookies scoped to a domain it does not control.
 */
export function createCookieAdvancedConfig(
	baseURL: string,
	crossSubDomainDomain?: string,
) {
	const { hostname } = new URL(baseURL);
	if (
		hostname === 'localhost' ||
		hostname === '127.0.0.1' ||
		hostname === '[::1]'
	) {
		return {
			useSecureCookies: false,
			defaultCookieAttributes: {
				sameSite: 'lax',
				secure: false,
			},
		} satisfies NonNullable<BetterAuthOptions['advanced']>;
	}

	return {
		useSecureCookies: true,
		...(crossSubDomainDomain && {
			crossSubDomainCookies: { enabled: true, domain: crossSubDomainDomain },
		}),
		defaultCookieAttributes: {
			sameSite: 'none',
			secure: true,
		},
	} satisfies NonNullable<BetterAuthOptions['advanced']>;
}
