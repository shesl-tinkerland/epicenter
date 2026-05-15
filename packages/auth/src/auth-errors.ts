import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';

export const AuthError = defineErrors({
	StartSignInFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to start sign-in: ${extractErrorMessage(cause)}`,
		cause,
	}),
	SignOutFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to sign out: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/**
	 * `/api/me` failed during sign-in or cold boot. Non-fatal on cold boot:
	 * the cached `localIdentity` keeps the user signed-in and able to decrypt
	 * local Yjs data.
	 */
	VerifyIdentityFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to verify identity: ${extractErrorMessage(cause)}`,
		cause,
	}),
	RefreshGrantFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to refresh OAuth grant: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

export type AuthError = InferErrors<typeof AuthError>;
