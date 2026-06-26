/**
 * The OAuth social providers a deployment has configured, derived from its env.
 *
 * This is the single source of truth for two readers that must never disagree:
 * {@link createAuth} registers exactly these providers with Better Auth, and the
 * self-host Bun entry counts them to recompute its shape. A provider is
 * "configured" only when BOTH its client id and secret are present, mirroring
 * the register-when-present rule (ADR-0071): a deployment without a given OAuth
 * app simply does not offer that sign-in, the same way GitHub has always been
 * gated. Google is no longer special; it joins GitHub as optional.
 *
 * The self-host entry's solo-vs-shared selector reads the SAME function, so it
 * can never disagree with what actually accepts a sign-in: an empty set is a
 * solo box reached with a first-boot bearer; a non-empty set is a shared wiki
 * those providers' users sign into (ADR-0072).
 */

/** The portable OAuth-provider secrets, all optional (register-when-present). */
export type OAuthProviderEnv = {
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	GITHUB_CLIENT_ID?: string;
	GITHUB_CLIENT_SECRET?: string;
};

/**
 * Build the `socialProviders` config for the providers this deployment has
 * configured. An absent id/secret pair drops that provider from the object
 * entirely, so `Object.keys(...)` is exactly the set of usable sign-in methods.
 */
export function configuredSocialProviders(env: OAuthProviderEnv): {
	google?: { clientId: string; clientSecret: string };
	github?: { clientId: string; clientSecret: string };
} {
	return {
		...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
			? {
					google: {
						clientId: env.GOOGLE_CLIENT_ID,
						clientSecret: env.GOOGLE_CLIENT_SECRET,
					},
				}
			: {}),
		// GitHub is deliberately NOT a trusted linking provider (see
		// BASE_AUTH_CONFIG): it can return an unverified primary email, so it only
		// links into an existing same-email account when GitHub reports the email
		// verified.
		...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
			? {
					github: {
						clientId: env.GITHUB_CLIENT_ID,
						clientSecret: env.GITHUB_CLIENT_SECRET,
					},
				}
			: {}),
	};
}
