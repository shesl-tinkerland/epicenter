/**
 * Billing policy orchestration tests.
 *
 * Pins the no-overcharge contract for AI and the stock-sync contract for
 * storage. AI reservations are committed (`confirm`) only on a successful
 * response and rolled back (`release`) otherwise. Asset uploads check quota
 * before the route runs, and successful asset mutations sync Autumn to the
 * authoritative storage total returned by the library. The service (every
 * Autumn round-trip) is mocked at its module boundary; these tests own only the
 * policy's HTTP orchestration.
 *
 * The reservation object hides the `lockId`: the policy only ever calls
 * `confirm()` / `release()`, so there is no lock action to mispair. The policy
 * pushes the settlement/sync op onto `afterResponse` by calling it, so
 * confirm/release/sync are recorded synchronously during the request.
 *
 * A worker crash between reserve and finalize is intentionally NOT exercised:
 * that path is covered by Autumn's lock TTL auto-release, not by code here.
 */

import { beforeEach, expect, mock, test } from 'bun:test';
import { AiChatError } from '@epicenter/constants/ai-chat-errors';
import { AssetError } from '@epicenter/constants/asset-errors';
import { ASSET_STORAGE_USAGE_TOTAL_HEADER } from '@epicenter/constants/asset-headers';
import type { Env } from '@epicenter/server';
import { Hono } from 'hono';
import { Ok, type Result } from 'wellcrafted/result';

type AiReserveOutcome = Result<
	Record<never, never>,
	| ReturnType<typeof AiChatError.UnknownModel>['error']
	| ReturnType<typeof AiChatError.InsufficientCredits>['error']
>;
type AssetCheckOutcome = Result<
	void,
	ReturnType<typeof AssetError.StorageLimitExceeded>['error']
>;

const finalizeCalls: Array<'confirm' | 'release'> = [];
const storageSyncCalls: number[] = [];
let aiReserveOutcome: AiReserveOutcome = Ok({});
let assetCheckOutcome: AssetCheckOutcome = Ok(undefined);

/** A reservation whose confirm/release record the action and resolve Ok. */
function recordingReservation() {
	return {
		confirm: () => {
			finalizeCalls.push('confirm');
			return Promise.resolve(Ok(undefined));
		},
		release: () => {
			finalizeCalls.push('release');
			return Promise.resolve(Ok(undefined));
		},
	};
}

mock.module('./service.js', () => ({
	createBillingService: () => ({
		reserveAiChat: async (_input: { model: string }) =>
			aiReserveOutcome.error ? aiReserveOutcome : Ok(recordingReservation()),
		checkAssetStorageUpload: async (_input: { sizeBytes: number }) =>
			assetCheckOutcome,
		syncAssetStorageUsageTotal: (totalBytes: number) => {
			storageSyncCalls.push(totalBytes);
			return Promise.resolve(Ok(undefined));
		},
	}),
}));

const { chargeAiCreditsWithAutumn, syncAssetStorageWithAutumn } = await import(
	'./policies.js'
);

beforeEach(() => {
	finalizeCalls.length = 0;
	storageSyncCalls.length = 0;
	aiReserveOutcome = Ok({});
	assetCheckOutcome = Ok(undefined);
});

function withContext(app: Hono<Env>) {
	app.use('*', async (c, next) => {
		c.set('afterResponse', []);
		c.set('user', {
			id: 'user_1',
			email: 'user@example.com',
		} as Env['Variables']['user']);
		await next();
	});
	return app;
}

// ----- AI chat policy --------------------------------------------------

/** Mount the AI policy around a stub chat handler that returns `downstreamStatus`. */
function makeAiApp(downstreamStatus: 200 | 500) {
	const app = withContext(new Hono<Env>());
	app.use('/ai/chat', chargeAiCreditsWithAutumn);
	app.post('/ai/chat', (c) => c.body(null, downstreamStatus));
	return app;
}

function aiRequest(app: Hono<Env>, body: unknown) {
	return app.request('/ai/chat', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

test('a successful chat (200) confirms the reservation', async () => {
	const res = await aiRequest(makeAiApp(200), { data: { model: 'gpt' } });

	expect(res.status).toBe(200);
	expect(finalizeCalls).toEqual(['confirm']);
});

test('a pre-stream failure (>= 400) releases the reservation, never charging', async () => {
	const res = await aiRequest(makeAiApp(500), { data: { model: 'gpt' } });

	expect(res.status).toBe(500);
	expect(finalizeCalls).toEqual(['release']);
});

test('a BYOK key bypasses billing entirely (no reservation)', async () => {
	const res = await aiRequest(makeAiApp(200), {
		data: { model: 'gpt' },
		apiKey: 'sk-user-key',
	});

	expect(res.status).toBe(200);
	expect(finalizeCalls).toHaveLength(0);
});

test('an AI guard rejection answers with the envelope and reserves nothing', async () => {
	aiReserveOutcome = AiChatError.InsufficientCredits({ balance: 0 });

	const res = await aiRequest(makeAiApp(200), { data: { model: 'gpt' } });

	expect(res.status).toBe(402);
	const body = (await res.json()) as { data: unknown; error: { name: string } };
	expect(body.data).toBeNull();
	expect(body.error.name).toBe('InsufficientCredits');
	expect(finalizeCalls).toHaveLength(0);
});

// ----- Asset storage policy --------------------------------------------

/** Mount the storage policy around a stub upload/delete handler. */
function makeAssetApp(downstreamStatus: 201 | 500 | 204) {
	const app = withContext(new Hono<Env>());
	app.use('/assets', syncAssetStorageWithAutumn);
	app.post('/assets', (c) =>
		c.body(null, downstreamStatus, {
			[ASSET_STORAGE_USAGE_TOTAL_HEADER]: '5120',
		}),
	);
	app.delete('/assets', (c) =>
		c.body(null, downstreamStatus, {
			[ASSET_STORAGE_USAGE_TOTAL_HEADER]: '4096',
		}),
	);
	return app;
}

function uploadForm() {
	const form = new FormData();
	form.set('file', new File([new Uint8Array(1024)], 'a.bin'));
	return form;
}

test('a successful upload (201) syncs the authoritative storage total', async () => {
	const res = await makeAssetApp(201).request('/assets', {
		method: 'POST',
		body: uploadForm(),
	});

	expect(res.status).toBe(201);
	expect(storageSyncCalls).toEqual([5120]);
	expect(finalizeCalls).toHaveLength(0);
});

test('a failed upload (500) does not sync storage usage', async () => {
	const res = await makeAssetApp(500).request('/assets', {
		method: 'POST',
		body: uploadForm(),
	});

	expect(res.status).toBe(500);
	expect(storageSyncCalls).toHaveLength(0);
	expect(finalizeCalls).toHaveLength(0);
});

test('a storage guard rejection answers with the envelope and syncs nothing', async () => {
	assetCheckOutcome = AssetError.StorageLimitExceeded({
		requestedBytes: 1024,
	});

	const res = await makeAssetApp(201).request('/assets', {
		method: 'POST',
		body: uploadForm(),
	});

	expect(res.status).toBe(402);
	const body = (await res.json()) as { data: unknown; error: { name: string } };
	expect(body.data).toBeNull();
	expect(body.error.name).toBe('StorageLimitExceeded');
	expect(storageSyncCalls).toHaveLength(0);
	expect(finalizeCalls).toHaveLength(0);
});

test('a delete (204) syncs the authoritative storage total', async () => {
	const res = await makeAssetApp(204).request('/assets', { method: 'DELETE' });

	expect(res.status).toBe(204);
	expect(storageSyncCalls).toEqual([4096]);
	expect(finalizeCalls).toHaveLength(0);
});

test('a success without the usage header syncs nothing (guard holds)', async () => {
	// A 201/204 that omits the header must not push `balances.update({ usage: NaN })`.
	const app = withContext(new Hono<Env>());
	app.use('/assets', syncAssetStorageWithAutumn);
	app.post('/assets', (c) => c.body(null, 201));

	const res = await app.request('/assets', {
		method: 'POST',
		body: uploadForm(),
	});

	expect(res.status).toBe(201);
	expect(storageSyncCalls).toHaveLength(0);
});
