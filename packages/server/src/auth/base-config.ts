import type { BetterAuthOptions } from 'better-auth';

export const AUTH_BASE_PATH = '/auth';

/** Shared Better Auth config used by both the runtime and the CLI schema tool. */
export const BASE_AUTH_CONFIG = {
	basePath: AUTH_BASE_PATH,
	// Email/password is intentionally disabled. The social IdPs are the only
	// sign-in methods and assert verified emails; no mail sender is wired up,
	// so a local account could never verify. better-auth 1.6.18's
	// `requireLocalEmailVerified` linking gate (default true) closes the old
	// pre-registered-unverified-account takeover path, but an unverifiable
	// credential flow is still not one we serve. Do not re-enable without first
	// wiring email verification (sendVerificationEmail) and
	// requireEmailVerification.
	emailAndPassword: { enabled: false },
	account: {
		// Only Google is a trusted linking provider. A trusted provider bypasses
		// the incoming `emailVerified` check (better-auth 1.6.18 `link-account`
		// gate: `!isTrustedProvider && !userInfo.emailVerified`, plus a
		// `requireLocalEmailVerified` check on the existing user), so the set must
		// contain only IdPs that always assert a verified email. Google does;
		// GitHub does NOT (it can return an unverified primary email), so GitHub
		// is intentionally excluded even when enabled in create-auth.ts: an
		// untrusted GitHub identity only links to an existing same-email account
		// when GitHub itself reports the email verified. `email-password` is
		// absent because local credentials are disabled above.
		accountLinking: {
			enabled: true,
			trustedProviders: ['google'],
		},
	},
} satisfies BetterAuthOptions;
