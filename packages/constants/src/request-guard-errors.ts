import { defineErrors, type InferErrors } from 'wellcrafted/error';

/**
 * Structured error variants for request-boundary refusals.
 *
 * Emitted before the resource handler runs domain logic. Four flavors,
 * grouped because they share the property "request was malformed at the
 * boundary, not by the domain":
 *
 *   - `OwnerMismatch` (403): middleware-level auth refusal: URL owner
 *     does not match the authenticated user.
 *   - `NotAdmitted` (403): middleware-level admission refusal: the
 *     authenticated user is not admitted to this shared-wiki deployment.
 *   - `ForbiddenOrigin` (403): middleware-level CSRF refusal: origin
 *     missing or not in the trusted-origin allowlist.
 *   - `MissingNodeId` (400): route-level input refusal: WebSocket
 *     upgrade is missing the required `nodeId` query parameter.
 *
 * Defined once in the shared constants package so server runtime and
 * any client SDK reference the same discriminated union. The server
 * calls the factories at runtime (`RequestGuardError.OwnerMismatch()`);
 * clients import the type via `InferErrors` for zero-cost narrowing.
 *
 * The serialized envelope is `wellcrafted`'s `{ data: null, error: {
 * name, message, ...fields } }`. Receivers branch on `body.error.name`.
 *
 * Each variant carries its own HTTP `status`, so call sites just forward
 * the baked-in code to `c.json`. No external status mapper required.
 *
 * @example
 * ```ts
 * // Server: runtime usage
 * import { RequestGuardError } from '@epicenter/constants/request-guard-errors';
 * const err = RequestGuardError.OwnerMismatch();
 * return c.json(err, err.error.status); // 403, baked into the variant
 *
 * // Client: type-only narrowing
 * import type { RequestGuardError } from '@epicenter/constants/request-guard-errors';
 * function handle(error: RequestGuardError) {
 *   switch (error.name) {
 *     case 'OwnerMismatch':     // wrong URL for this signed-in user
 *     case 'NotAdmitted':       // signed in but not admitted
 *     case 'ForbiddenOrigin':   // CSRF: origin missing or not trusted
 *     case 'MissingNodeId':   // WebSocket upgrade without ?nodeId=
 *   }
 * }
 * ```
 */
export const RequestGuardError = defineErrors({
	OwnerMismatch: () => ({
		message: 'The request URL owner does not match the authenticated user.',
		status: 403 as const,
	}),
	NotAdmitted: () => ({
		message:
			'The authenticated user is not admitted to this shared-wiki deployment.',
		status: 403 as const,
	}),
	ForbiddenOrigin: () => ({
		message: 'Origin header is missing or not in the trusted-origin allowlist.',
		status: 403 as const,
	}),
	MissingNodeId: () => ({
		message:
			'WebSocket upgrade is missing the required nodeId query parameter.',
		status: 400 as const,
	}),
});

/**
 * Discriminated union of all request-guard error payloads.
 *
 * The `name` field discriminates variants in exhaustive `switch`
 * statements with `default: error satisfies never`.
 */
export type RequestGuardError = InferErrors<typeof RequestGuardError>;
