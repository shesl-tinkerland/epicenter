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
 * app.use(API_ROUTES.ai.completions.prefixPattern, requireBearerUser, requireOwnership);
 *
 * // Client fetch
 * const res = await fetch(API_ROUTES.session.url(baseURL));
 * ```
 */

const stripTrailing = (s: string) => s.replace(/\/+$/, '');

/**
 * 64-character lowercase-hex sha256. A blob's id IS its content address, so
 * the route param is constrained to a well-formed digest.
 */
export const SHA256_HEX_REGEX = '[a-f0-9]{64}';

export const API_ROUTES = {
	session: {
		pattern: '/api/session',
		url: (baseURL: string) => `${stripTrailing(baseURL)}/api/session`,
	},
	/**
	 * Content-addressed blob store. POST mints an upload ticket (presigned R2
	 * PUT); GET on the collection lists; GET/DELETE by `:sha256` read/remove a
	 * blob. R2 is the only index — there is no database row. See
	 * `docs/adr/0088-the-blob-store-is-a-presigned-s3-kernel-and-the-bucket-is-its-only-index.md`.
	 */
	blobs: {
		list: {
			pattern: '/api/owners/:ownerId/blobs',
			url: (baseURL: string, ownerId: OwnerId) =>
				`${stripTrailing(baseURL)}/api/owners/${encodeURIComponent(ownerId)}/blobs`,
		},
		byHash: {
			pattern: `/api/owners/:ownerId/blobs/:sha256{${SHA256_HEX_REGEX}}`,
			url: (baseURL: string, ownerId: OwnerId, sha256: string) =>
				`${stripTrailing(baseURL)}/api/owners/${encodeURIComponent(ownerId)}/blobs/${encodeURIComponent(sha256)}`,
		},
	},
	ai: {
		/**
		 * The OpenAI-compatible inference gateway (ADR-0050). Lives at the root
		 * `/v1` (the de-facto OpenAI path) so any OpenAI-compatible client points
		 * at `<origin>/v1` and works unchanged. `baseUrl` is what the client engine
		 * is configured with; it appends `/chat/completions`.
		 *
		 * `prefixPattern` is scoped to `/v1/chat/*`, not the whole `/v1/*` tree, so
		 * the chat auth + metering middleware does not also wrap the sibling
		 * `/v1/audio/transcriptions` gateway (which carries its own, different
		 * metering). One Connection (`baseUrl` = `<origin>/v1`) drives both.
		 */
		completions: {
			pattern: '/v1/chat/completions',
			prefixPattern: '/v1/chat/*',
			url: (baseURL: string) => `${stripTrailing(baseURL)}/v1/chat/completions`,
			baseUrl: (baseURL: string) => `${stripTrailing(baseURL)}/v1`,
		},
		/**
		 * The OpenAI-compatible speech-to-text gateway (ADR-0050/0056). The STT
		 * sibling of the chat gateway, on the same `<origin>/v1` Connection base:
		 * `transcribe()` appends `/audio/transcriptions`. Scoped middleware lives
		 * under `/v1/audio/*` so its metering never crosses into chat.
		 */
		transcriptions: {
			pattern: '/v1/audio/transcriptions',
			prefixPattern: '/v1/audio/*',
			url: (baseURL: string) =>
				`${stripTrailing(baseURL)}/v1/audio/transcriptions`,
		},
	},
} as const;
// The billing prefix (`/api/billing`) lives in apps/api/worker/billing/routes.ts:
// it is hosted-only and the self-hosted single-partition instance never mounts it.
