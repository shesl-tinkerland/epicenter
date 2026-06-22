import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { AppConfig } from './config.ts';
import type { QbObject } from './entities.ts';
import type { TokenError, TokenManager } from './token-manager.ts';

/**
 * The QuickBooks Online data-API client: the paginated query API for full pulls
 * and the `/cdc` endpoint for incremental refresh. Handles the wire concerns the
 * sync engine should not care about: bearer auth from the token manager,
 * one-shot refresh on 401, and backoff on 429 (`ThrottleExceeded`) / 5xx.
 *
 * Grounded limits (developer.intuit.com): 500 req/min and 10 concurrent per
 * realm; query/CDC return at most 1000 objects per page; CDC covers a 30-day
 * lookback. On 429 QuickBooks asks callers to wait ~60s.
 */

export const QbApiError = defineErrors({
	Network: ({ cause }: { cause: unknown }) => ({
		message: `Network error calling the QuickBooks API: ${String(cause)}`,
		cause,
	}),
	Http: ({ status, body }: { status: number; body: string }) => ({
		message: `QuickBooks API returned ${status}: ${body.slice(0, 500)}`,
		status,
		body,
	}),
	Unauthorized: ({ body }: { body: string }) => ({
		message: `QuickBooks API rejected the access token (401): ${body.slice(0, 300)}`,
		body,
	}),
	Throttled: ({ retries }: { retries: number }) => ({
		message: `QuickBooks API throttled the request (429) after ${retries} retries.`,
		retries,
	}),
	InvalidResponse: ({ detail }: { detail: string }) => ({
		message: `QuickBooks API response was not the expected JSON shape: ${detail}`,
		detail,
	}),
});
export type QbApiError = InferErrors<typeof QbApiError>;

export type QbClientError = QbApiError | TokenError;

/** A page of query results: the objects plus whether more pages may follow. */
export type QueryPage = { objects: QbObject[]; hasMore: boolean };

/** CDC changes grouped by entity name. Deletes are included (status: "Deleted"). */
export type CdcResult = { changes: Record<string, QbObject[]> };

export type QbClient = {
	readonly realmId: string;
	queryPage(
		entity: string,
		startPosition: number,
	): Promise<Result<QueryPage, QbClientError>>;
	queryAll(entity: string): Promise<Result<QbObject[], QbClientError>>;
	cdc(
		entities: string[],
		changedSince: string,
	): Promise<Result<CdcResult, QbClientError>>;
};

export type QbClientDeps = {
	config: AppConfig;
	realmId: string;
	tokens: TokenManager;
	fetchImpl?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	log?: (message: string) => void;
	/** Retry budget for 429 / 5xx / transient network errors. */
	maxRetries?: number;
	/** Wait applied on 429 when the response has no Retry-After. */
	throttleWaitMs?: number;
};

function retryAfterMs(response: Response): number | null {
	const header = response.headers.get('retry-after');
	if (!header) return null;
	const seconds = Number(header);
	return Number.isFinite(seconds) ? seconds * 1000 : null;
}

export function createQbClient(deps: QbClientDeps): QbClient {
	const { config, realmId, tokens } = deps;
	const fetchImpl = deps.fetchImpl ?? fetch;
	const sleep =
		deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const log = deps.log ?? (() => {});
	const maxRetries = deps.maxRetries ?? 5;
	const throttleWaitMs = deps.throttleWaitMs ?? 60_000;
	const pageSize = config.pageSize;

	const backoffMs = (attempt: number) =>
		Math.min(throttleWaitMs, 500 * 2 ** attempt);

	async function request(
		path: string,
		params: Record<string, string>,
	): Promise<Result<unknown, QbClientError>> {
		const url = new URL(`${config.apiBase}/v3/company/${realmId}/${path}`);
		for (const [key, value] of Object.entries(params))
			url.searchParams.set(key, value);
		url.searchParams.set('minorversion', config.minorVersion);

		let attempt = 0;
		let refreshed = false;

		while (true) {
			const token = await tokens.getValidAccessToken();
			if (token.error) return token;

			let response: Response;
			try {
				response = await fetchImpl(url.toString(), {
					headers: {
						Authorization: `Bearer ${token.data}`,
						Accept: 'application/json',
					},
				});
			} catch (cause) {
				if (attempt < maxRetries) {
					attempt += 1;
					await sleep(backoffMs(attempt));
					continue;
				}
				return QbApiError.Network({ cause });
			}

			if (response.ok) {
				const json = await response.json().catch(() => null);
				if (json === null || typeof json !== 'object') {
					return QbApiError.InvalidResponse({
						detail: 'body was not a JSON object',
					});
				}
				return Ok(json);
			}

			if (response.status === 401 && !refreshed) {
				refreshed = true;
				const forced = await tokens.forceRefresh();
				if (forced.error) return forced;
				continue;
			}

			if (response.status === 429) {
				if (attempt >= maxRetries)
					return QbApiError.Throttled({ retries: attempt });
				attempt += 1;
				const wait = retryAfterMs(response) ?? throttleWaitMs;
				log(
					`QuickBooks throttled (429); waiting ${wait}ms before retry ${attempt}/${maxRetries}.`,
				);
				await sleep(wait);
				continue;
			}

			if (response.status >= 500) {
				if (attempt >= maxRetries) {
					const body = await response.text().catch(() => '');
					return QbApiError.Http({ status: response.status, body });
				}
				attempt += 1;
				await sleep(backoffMs(attempt));
				continue;
			}

			const body = await response.text().catch(() => '');
			if (response.status === 401) return QbApiError.Unauthorized({ body });
			return QbApiError.Http({ status: response.status, body });
		}
	}

	function extractQueryArray(json: unknown, entity: string): QbObject[] {
		const queryResponse = (json as { QueryResponse?: Record<string, unknown> })
			.QueryResponse;
		const arr = queryResponse?.[entity];
		return Array.isArray(arr) ? (arr as QbObject[]) : [];
	}

	const client: QbClient = {
		realmId,

		async queryPage(entity, startPosition) {
			const query = `select * from ${entity} startposition ${startPosition} maxresults ${pageSize}`;
			const { data, error } = await request('query', { query });
			if (error) return { data: null, error };
			const objects = extractQueryArray(data, entity);
			return Ok({ objects, hasMore: objects.length === pageSize });
		},

		async queryAll(entity) {
			const all: QbObject[] = [];
			let startPosition = 1;
			while (true) {
				const { data, error } = await client.queryPage(entity, startPosition);
				if (error) return { data: null, error };
				all.push(...data.objects);
				if (!data.hasMore) break;
				startPosition += pageSize;
			}
			return Ok(all);
		},

		async cdc(entities, changedSince) {
			const { data, error } = await request('cdc', {
				entities: entities.join(','),
				changedSince,
			});
			if (error) return { data: null, error };

			const changes: Record<string, QbObject[]> = {};
			const cdcResponse = (data as { CDCResponse?: unknown }).CDCResponse;
			if (Array.isArray(cdcResponse)) {
				for (const block of cdcResponse) {
					const queryResponses = (block as { QueryResponse?: unknown })
						.QueryResponse;
					if (!Array.isArray(queryResponses)) continue;
					for (const qr of queryResponses) {
						for (const entity of entities) {
							const arr = (qr as Record<string, unknown>)[entity];
							if (Array.isArray(arr)) {
								changes[entity] ??= [];
								changes[entity].push(...(arr as QbObject[]));
							}
						}
					}
				}
			}
			return Ok({ changes });
		},
	};

	return client;
}
