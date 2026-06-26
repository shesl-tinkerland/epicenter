/**
 * The OAuth social providers a deployment has configured, derived from its env.
 *
 * Single source of truth for two readers: {@link configuredSocialProviders} is
 * what {@link createAuth} registers with Better Auth, and the self-host entry
 * reads both this and {@link incompleteSocialProviders} for its boot-time
 * coherence checks. A provider is "configured" only when BOTH its client id and
 * secret are present, mirroring the register-when-present rule (ADR-0071): a
 * deployment without a given OAuth app simply does not offer that sign-in, the
 * same way GitHub has always been gated. Google is no longer special; it joins
 * GitHub as optional.
 *
 * The self-host entry no longer derives its MODE from this set (ADR-0072): the
 * partition (personal vs shared) is an explicit launch choice, so adding or
 * rotating a credential can never silently re-partition a running box. The entry
 * instead checks that the configured set AGREES with the declared mode, and
 * {@link incompleteSocialProviders} rejects a half-configured pair (an id without
 * its secret, the typo that used to silently flip a wiki into a solo box) loudly
 * at boot rather than dropping it.
 */

/** The portable OAuth-provider secrets, all optional (register-when-present). */
export type OAuthProviderEnv = {
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	GITHUB_CLIENT_ID?: string;
	GITHUB_CLIENT_SECRET?: string;
};

/**
 * The env-var pair that configures each provider, in ONE place, so "which keys
 * name this provider" has a single home that both the configured-set builder and
 * the incomplete-pair check read (no hand-mirrored key lists to drift apart).
 */
const PROVIDER_ENV = {
	google: { id: 'GOOGLE_CLIENT_ID', secret: 'GOOGLE_CLIENT_SECRET' },
	github: { id: 'GITHUB_CLIENT_ID', secret: 'GITHUB_CLIENT_SECRET' },
} as const satisfies Record<
	string,
	{ id: keyof OAuthProviderEnv; secret: keyof OAuthProviderEnv }
>;

/** A configured provider's Better Auth credentials. */
type ProviderCredentials = { clientId: string; clientSecret: string };

/**
 * Build the `socialProviders` config for the providers this deployment has fully
 * configured. A provider with only one of its id/secret set is dropped here (and
 * rejected at boot by {@link incompleteSocialProviders}), so `Object.keys(...)`
 * is exactly the set of usable sign-in methods.
 *
 * GitHub is deliberately NOT a trusted linking provider (see BASE_AUTH_CONFIG):
 * it can return an unverified primary email, so it only links into an existing
 * same-email account when GitHub reports the email verified.
 */
export function configuredSocialProviders(
	env: OAuthProviderEnv,
): { google?: ProviderCredentials; github?: ProviderCredentials } {
	const providers: { google?: ProviderCredentials; github?: ProviderCredentials } =
		{};
	for (const [name, keys] of Object.entries(PROVIDER_ENV)) {
		const clientId = env[keys.id];
		const clientSecret = env[keys.secret];
		if (clientId && clientSecret) {
			providers[name as keyof typeof PROVIDER_ENV] = { clientId, clientSecret };
		}
	}
	return providers;
}

/**
 * The providers with EXACTLY ONE of their client id / secret set: always a
 * misconfiguration (a typo'd or forgotten half of the pair). The self-host entry
 * fails boot on a non-empty result, so a half-configured provider can never be
 * silently dropped, which under the old provider-sniffing selector flipped an
 * intended wiki into a solo bearer box.
 */
export function incompleteSocialProviders(env: OAuthProviderEnv): string[] {
	return Object.entries(PROVIDER_ENV)
		.filter(([, keys]) => Boolean(env[keys.id]) !== Boolean(env[keys.secret]))
		.map(([name]) => name);
}
