import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';

/**
 * Public auth-core failures returned by `AuthClient` methods.
 *
 * Launcher and storage-specific errors stay as causes. Callers should branch on
 * the auth-core operation that failed, then inspect `cause` only for diagnostics.
 */
export const AuthError = defineErrors({
	StartSignInFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to start sign-in: ${extractErrorMessage(cause)}`,
		cause,
	}),
	SignOutFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to sign out: ${extractErrorMessage(cause)}`,
		cause,
	}),
	RefreshGrantFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to refresh OAuth grant: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

export type AuthError = InferErrors<typeof AuthError>;
