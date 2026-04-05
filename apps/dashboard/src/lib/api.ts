/**
 * Type-safe API client for the billing dashboard.
 *
 * Uses Hono's `hc` to get full type inference from the API's route types.
 * Same-origin deployment means no CORS config needed—just relative paths.
 *
 * In local dev, the Vite proxy forwards `/api` requests to the API server.
 * In production, the Worker serves both the SPA and API routes.
 *
 * @example
 * ```typescript
 * const res = await api.billing.balance.$get();
 * const data = await res.json(); // fully typed
 * ```
 */

import type { AppType } from '@epicenter/api';
import { hc } from 'hono/client';

export const api = hc<AppType>('/', {
	fetch: (input: RequestInfo | URL, init?: RequestInit) =>
		fetch(input, { ...init, credentials: 'include' }),
});
