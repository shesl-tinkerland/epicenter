import type { OwnerId } from '@epicenter/identity';

/**
 * Wire URL paths and Hono route patterns for the Epicenter API.
 *
 * One source of truth for every server route declaration, deployment
 * middleware pattern, and client fetch URL. Each leaf exposes:
 *
 *   - `pattern`        Hono-style route string (`/api/.../:param{regex}`)
 *                      consumed by `subApp.get(...)` declarations and
 *                      deployment `.use(...)` / `.on(...)` mounts.
 *   - `prefixPattern`  Wildcard variant (`/api/.../*`) for prefix-scoped
 *                      `.use(...)` middleware. Present only where the
 *                      surface has subpaths the bare pattern misses.
 *   - `url(...)`       Builder that produces a concrete absolute URL
 *                      from typed inputs. All path parameters are
 *                      `encodeURIComponent`-encoded.
 *
 * URL values here MUST match what production clients hit today. This
 * module moves declarations; it does not change wire shape.
 *
 * @example
 * ```ts
 * // Server route declaration
 * import { API_ROUTES } from '@epicenter/constants/api-routes';
 * export const roomsApp = new Hono<Env>()
 *   .get(API_ROUTES.session.pattern, handler);
 *
 * // Deployment middleware
 * app.use(API_ROUTES.ai.chat.prefixPattern, requireBearerUser, requireOwnership);
 *
 * // Client fetch
 * const res = await fetch(API_ROUTES.session.url(baseURL));
 * ```
 */

const stripTrailing = (s: string) => s.replace(/\/+$/, '');

/**
 * 21-character alphanumeric asset id. Bumped from 15 chars after
 * grounding against Signal/Bitwarden precedent and the historical
 * Slack file-token brute-force incident.
 */
export const ASSET_ID_REGEX = '[a-z0-9]{21}';

export const API_ROUTES = {
	session: {
		pattern: '/api/session',
		url: (baseURL: string) => `${stripTrailing(baseURL)}/api/session`,
	},
	assets: {
		list: {
			pattern: '/api/owners/:ownerId/assets',
			url: (baseURL: string, ownerId: OwnerId) =>
				`${stripTrailing(baseURL)}/api/owners/${encodeURIComponent(ownerId)}/assets`,
		},
		usage: {
			pattern: '/api/owners/:ownerId/assets/usage',
			url: (baseURL: string, ownerId: OwnerId) =>
				`${stripTrailing(baseURL)}/api/owners/${encodeURIComponent(ownerId)}/assets/usage`,
		},
		byId: {
			pattern: `/api/owners/:ownerId/assets/:assetId{${ASSET_ID_REGEX}}`,
			url: (baseURL: string, ownerId: OwnerId, assetId: string) =>
				`${stripTrailing(baseURL)}/api/owners/${encodeURIComponent(ownerId)}/assets/${encodeURIComponent(assetId)}`,
		},
	},
	ai: {
		chat: {
			pattern: '/api/ai/chat',
			prefixPattern: '/api/ai/*',
			url: (baseURL: string) => `${stripTrailing(baseURL)}/api/ai/chat`,
		},
	},
} as const;
// The billing prefix (`/api/billing`) lives in apps/api/worker/billing/routes.ts:
// it is hosted-only and self-hosted shared-wiki deployments never mount it.
