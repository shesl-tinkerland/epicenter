import type { AnyTaggedError } from 'wellcrafted/error';
import { Err, type Ok } from 'wellcrafted/result';
import type { UnifiedNotificationOptions } from '$lib/services/notifications/types';

/**
 * Custom error type for the Whispering application that combines error information
 * with notification display options. This error type is designed to be user-facing,
 * providing both error details and UI presentation information.
 */
export type WhisperingError = {
	readonly name: 'WhisperingError';
} & Omit<UnifiedNotificationOptions, 'variant'> & {
		severity: 'error' | 'warning';
	};

/**
 * Input type for creating WhisperingError.
 * Allows either explicit description or serviceError (which auto-extracts .message).
 */
type WhisperingErrorInput = Omit<
	WhisperingError,
	'name' | 'severity' | 'description'
> & {
	/** Explicit description text */
	description?: string;
	/** Service-layer error to adapt. If provided, error.message becomes description */
	serviceError?: AnyTaggedError;
};

/**
 * Normalizes input to WhisperingError by handling serviceError.
 * - If serviceError provided and no description, uses serviceError.message
 * - If action is missing and serviceError provided, adds more-details action
 */
function normalizeInput({
	serviceError,
	...rest
}: WhisperingErrorInput): Omit<WhisperingError, 'name' | 'severity'> {
	// Derive description from serviceError if not explicitly provided
	const description = rest.description ?? serviceError?.message ?? '';

	// Auto-add more-details action if serviceError provided and no action specified
	const action =
		rest.action ??
		(serviceError
			? { type: 'more-details' as const, error: serviceError }
			: undefined);

	return { ...rest, description, action };
}

/**
 * Creates a WhisperingError with 'error' severity.
 * This is the primary factory function for creating error objects in the application.
 *
 * @example
 * ```typescript
 * // With explicit description
 * WhisperingErr({ title: 'Error', description: 'Something went wrong' });
 *
 * // With serviceError (auto-extracts message and adds more-details action)
 * WhisperingErr({ title: 'Error', serviceError: taggedError });
 * ```
 */
const WhisperingError = (args: WhisperingErrorInput): WhisperingError => ({
	name: 'WhisperingError',
	severity: 'error',
	...normalizeInput(args),
});

/**
 * Creates a Err wrapping a WhisperingError.
 */
export const WhisperingErr = (args: WhisperingErrorInput) =>
	Err(WhisperingError(args));

/**
 * Creates a WhisperingError with 'warning' severity.
 */
const WhisperingWarning = (args: WhisperingErrorInput): WhisperingError => ({
	name: 'WhisperingError',
	severity: 'warning',
	...normalizeInput(args),
});

/**
 * Creates a Err wrapping a WhisperingError with 'warning' severity.
 */
export const WhisperingWarningErr = (args: WhisperingErrorInput) =>
	Err(WhisperingWarning(args));

/**
 * Result type for Whispering operations that can fail.
 * Follows the Result pattern where operations return either Ok<T> or Err<WhisperingError>.
 *
 * @template T - The type of the success value
 */
export type WhisperingResult<T> = Ok<T> | Err<WhisperingError>;

