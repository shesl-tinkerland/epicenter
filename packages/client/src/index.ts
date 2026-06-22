/**
 * `@epicenter/client`: typed HTTP client for the Epicenter server.
 *
 * Wraps `assets` and `session` surfaces. Composes on
 * `AuthFetch` from `@epicenter/auth`, which handles OAuth bearer attach,
 * refresh, and 401 propagation. This package does not own auth state;
 * it consumes the authed fetch handle.
 *
 * Works against any Epicenter deployment (cloud at `epicenter.so` or a
 * self-hosted shared-wiki server).
 */

import type { ApiSessionResponse, AuthFetch } from '@epicenter/auth';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import type { OwnerId } from '@epicenter/identity';

export type {
	AgentEngine,
	AgentEngineRequest,
	AgentEngineToolDefinition,
	EngineChunk,
	EngineFetch,
	ModelMessage,
	ModelToolCall,
} from './agent-engine.js';
export {
	createOpenAiAgentEngine,
	type OpenAiProviderData,
} from './openai-provider.js';

export type EpicenterClientOptions = {
	/** Base URL of the Epicenter server (no trailing slash required). */
	baseURL: string;
	/**
	 * Authenticated fetch. Produced by `createOAuthAppAuth({...}).fetch`
	 * from `@epicenter/auth`. The client does not own auth lifecycle.
	 */
	fetch: AuthFetch;
};

// ---------------------------------------------------------------------------
// Asset types (mirror the server response shapes)
// ---------------------------------------------------------------------------

export type AssetVisibility = 'private' | 'public';

export type UploadAssetResponse = {
	id: string;
	/** Server-relative URL: `/api/owners/<ownerId>/assets/<assetId>`. */
	url: string;
	visibility: AssetVisibility;
	contentType: string;
	size: number;
	originalName: string;
};

export type AssetRow = {
	id: string;
	ownerId: OwnerId;
	contentType: string;
	sizeBytes: number;
	originalName: string;
	visibility: AssetVisibility;
	uploadedAt: string;
};

export type SetVisibilityResponse = {
	id: string;
	visibility: AssetVisibility;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a typed Epicenter client bound to a base URL and an authed fetch.
 *
 * Lazy-fetches `/api/session` on first call to resolve `ownerId`, then
 * caches it so subsequent URL builds are synchronous. Apps that need a
 * URL before the first async call should `await epicenter.ready()` at
 * boot.
 */
export function createEpicenterClient(opts: EpicenterClientOptions) {
	const base = opts.baseURL.replace(/\/+$/, '');
	let cachedSession: ApiSessionResponse | null = null;

	async function getSession(): Promise<ApiSessionResponse> {
		if (cachedSession) return cachedSession;
		const res = await opts.fetch(API_ROUTES.session.url(base));
		if (!res.ok) {
			throw new Error(`epicenter: /api/session returned ${res.status}`);
		}
		cachedSession = (await res.json()) as ApiSessionResponse;
		return cachedSession;
	}

	async function getOwnerId(): Promise<OwnerId> {
		return (await getSession()).ownerId;
	}

	const session = {
		/** Read the cached session, fetching once if needed. */
		current: getSession,
		/** Force a re-fetch of `/api/session` and update the cache. */
		async refresh(): Promise<ApiSessionResponse> {
			cachedSession = null;
			return getSession();
		},
	};

	const assets = {
		async upload(
			file: File,
			params: { visibility?: AssetVisibility } = {},
		): Promise<UploadAssetResponse> {
			const ownerId = await getOwnerId();
			const fd = new FormData();
			fd.append('file', file);
			fd.append('visibility', params.visibility ?? 'private');
			const res = await opts.fetch(API_ROUTES.assets.list.url(base, ownerId), {
				method: 'POST',
				body: fd,
			});
			if (!res.ok) {
				throw new Error(`epicenter.assets.upload: ${res.status}`);
			}
			return (await res.json()) as UploadAssetResponse;
		},

		async list(): Promise<AssetRow[]> {
			const ownerId = await getOwnerId();
			const res = await opts.fetch(API_ROUTES.assets.list.url(base, ownerId));
			if (!res.ok) {
				throw new Error(`epicenter.assets.list: ${res.status}`);
			}
			return (await res.json()) as AssetRow[];
		},

		async usage(): Promise<{ totalBytes: number }> {
			const ownerId = await getOwnerId();
			const res = await opts.fetch(API_ROUTES.assets.usage.url(base, ownerId));
			if (!res.ok) {
				throw new Error(`epicenter.assets.usage: ${res.status}`);
			}
			return (await res.json()) as { totalBytes: number };
		},

		async setVisibility(
			id: string,
			visibility: AssetVisibility,
		): Promise<SetVisibilityResponse> {
			const ownerId = await getOwnerId();
			const res = await opts.fetch(
				API_ROUTES.assets.byId.url(base, ownerId, id),
				{
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ visibility }),
				},
			);
			if (!res.ok) {
				throw new Error(`epicenter.assets.setVisibility: ${res.status}`);
			}
			return (await res.json()) as SetVisibilityResponse;
		},

		async delete(id: string): Promise<void> {
			const ownerId = await getOwnerId();
			const res = await opts.fetch(
				API_ROUTES.assets.byId.url(base, ownerId, id),
				{ method: 'DELETE' },
			);
			if (!res.ok) {
				throw new Error(`epicenter.assets.delete: ${res.status}`);
			}
		},

		/**
		 * Build the full URL for an asset. Sync; requires the cached session
		 * (call `epicenter.ready()` once at boot if you need to build URLs
		 * before any other async call resolves).
		 *
		 * Useful for embedding in Yjs documents, `<img src>`, share buttons.
		 */
		url(id: string): string {
			if (!cachedSession) {
				throw new Error(
					'epicenter.assets.url: session not yet resolved. ' +
						'Call `await epicenter.ready()` once at app boot, or ' +
						'await any other assets.* method first.',
				);
			}
			return API_ROUTES.assets.byId.url(base, cachedSession.ownerId, id);
		},
	};

	return {
		/**
		 * Resolve and cache the session. Call once at app boot if any code
		 * path uses synchronous URL builders like `assets.url(id)` before
		 * an awaited async call.
		 */
		async ready(): Promise<void> {
			await getSession();
		},
		assets,
		session,
	};
}

export type EpicenterClient = ReturnType<typeof createEpicenterClient>;
