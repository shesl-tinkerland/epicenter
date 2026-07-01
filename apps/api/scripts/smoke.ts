/**
 * One-scenario smoke test for the runtime port. Same backend, either runtime.
 *
 * Point it at a base URL and it runs ONE end-to-end scenario against the live
 * HTTP server: read the session, open a room, and exercise the full
 * content-addressed blob lifecycle (ticket -> presigned PUT -> read back).
 * Every step prints a single PASS/FAIL/SKIP line, so the same
 * invocation against the Bun process (:8788) and the wrangler process (:8787)
 * produces a diffable transcript of runtime parity.
 *
 *   bun apps/api/scripts/smoke.ts http://localhost:8788   # Bun runtime port
 *   bun apps/api/scripts/smoke.ts http://localhost:8787   # wrangler dev
 *
 * Auth is the one thing the scenario cannot get over plain HTTP (email/password
 * is disabled and Google is interactive), so it relies on the server running
 * with the dev resolver injected: boot it via `bun run dev:bun:devauth`
 * (server.dev.ts), which resolves `Authorization: Bearer dev:<userId>` to a
 * synthetic user on localhost. The smoke just sends that header. In personal
 * mode the resolved id is the owner partition directly, so no user is seeded and
 * the script needs no database access of its own.
 *
 * Requirements to run:
 *   - BASE_URL reachable, and booted WITH the dev resolver (`dev:bun:devauth`).
 *     Against a production-auth server the authed steps return 401.
 *   - For a full green blob round-trip the server must have BLOBS_S3_* set
 *     (run `docker compose up -d` in apps/api for a local versitygw store);
 *     without object storage the blob routes answer 503 and the script reports
 *     that as an expected, non-fatal outcome.
 */

import { API_ROUTES } from '@epicenter/constants/api-routes';
import { API_BUN_DEV_PORT } from '@epicenter/constants/apps';
import { asOwnerId } from '@epicenter/identity';

const BASE_URL = (
	process.argv[2] ??
	process.env.BASE_URL ??
	`http://localhost:${API_BUN_DEV_PORT}`
).replace(/\/+$/, '');

// The dev resolver synthesizes the user from this id; personal-mode ownership
// makes it the owner partition too. Random per run so repeated smokes never
// collide on room or blob state.
const userId = `smoke-${randHex(4)}`;
const authHeaders: Record<string, string> = {
	authorization: `Bearer dev:${userId}`,
};

// ── tiny step reporter ──────────────────────────────────────────────────────

type Status = 'PASS' | 'FAIL' | 'SKIP';
const rows: { status: Status; step: string; detail: string }[] = [];
function record(status: Status, step: string, detail: string) {
	rows.push({ status, step, detail });
	console.log(`  [${status}] ${step.padEnd(26)} ${detail}`);
}

function randHex(bytes: number): string {
	return [...crypto.getRandomValues(new Uint8Array(bytes))]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

async function sha256Hex(data: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

// ── scenario ────────────────────────────────────────────────────────────────

async function main() {
	console.log(`\nSmoke scenario against ${BASE_URL}\n`);

	// 1. Health (no auth). Also reports which runtime answered.
	try {
		const res = await fetch(`${BASE_URL}/`);
		const body = (await res.json()) as { runtime?: string };
		record(
			res.ok ? 'PASS' : 'FAIL',
			'health',
			`${res.status} runtime=${body.runtime ?? '?'}`,
		);
	} catch (err) {
		record('FAIL', 'health', `unreachable: ${(err as Error).message}`);
		return summarize();
	}

	// 2. Session: resolves the owner partition from the bearer.
	let ownerId = '';
	{
		const res = await fetch(API_ROUTES.session.url(BASE_URL), {
			headers: authHeaders,
		});
		if (res.ok) {
			ownerId = ((await res.json()) as { ownerId: string }).ownerId;
			record('PASS', 'session', `${res.status} ownerId=${ownerId}`);
		} else {
			record('FAIL', 'session', `${res.status} ${await res.text()}`);
			return summarize();
		}
	}

	// 3. Room: bearer-only surface. GET creates-on-first-touch and reads the doc.
	{
		const roomId = `smoke-${randHex(4)}`;
		const url = `${BASE_URL}/api/owners/${encodeURIComponent(ownerId)}/rooms/${roomId}?nodeId=smoke`;
		const res = await fetch(url, { headers: authHeaders });
		const buf = await res.arrayBuffer();
		record(
			res.ok ? 'PASS' : 'FAIL',
			'room open+read',
			`${res.status} doc=${buf.byteLength}B`,
		);
	}

	// 4. Blob lifecycle.
	const payload = new TextEncoder().encode(
		`epicenter blob smoke ${new Date().toISOString()} ${randHex(4)}\n`,
	);
	const sha256 = await sha256Hex(payload);
	const owner = asOwnerId(ownerId);
	const ticketRes = await fetch(API_ROUTES.blobs.list.url(BASE_URL, owner), {
		method: 'POST',
		headers: { ...authHeaders, 'content-type': 'application/json' },
		body: JSON.stringify({
			sha256,
			sizeBytes: payload.byteLength,
			contentType: 'text/plain',
		}),
	});

	if (ticketRes.status === 503) {
		record(
			'SKIP',
			'blob ticket',
			'503 StorageNotConfigured (no BLOBS_S3_* on this server), expected without S3',
		);
	} else if (!ticketRes.ok) {
		record(
			'FAIL',
			'blob ticket',
			`${ticketRes.status} ${await ticketRes.text()}`,
		);
	} else {
		const ticket = (await ticketRes.json()) as {
			status: 'upload' | 'duplicate';
			uploadUrl?: string;
			requiredHeaders?: Record<string, string>;
		};
		record(
			'PASS',
			'blob ticket',
			`${ticketRes.status} status=${ticket.status}`,
		);

		if (ticket.status === 'upload' && ticket.uploadUrl) {
			const putRes = await fetch(ticket.uploadUrl, {
				method: 'PUT',
				headers: ticket.requiredHeaders,
				body: payload,
			});
			record(
				putRes.ok ? 'PASS' : 'FAIL',
				'blob PUT (presigned)',
				`${putRes.status}`,
			);
		} else {
			record(
				'PASS',
				'blob PUT (presigned)',
				'skipped (duplicate, already stored)',
			);
		}

		// Read back: 302 -> presigned GET -> compare bytes.
		const readRes = await fetch(
			API_ROUTES.blobs.byHash.url(BASE_URL, owner, sha256),
			{ headers: authHeaders, redirect: 'manual' },
		);
		const presigned = readRes.headers.get('location');
		if (readRes.status === 302 && presigned) {
			const objRes = await fetch(presigned);
			const got = new Uint8Array(await objRes.arrayBuffer());
			const match =
				got.byteLength === payload.byteLength &&
				(await sha256Hex(got)) === sha256;
			record(
				match ? 'PASS' : 'FAIL',
				'blob read back',
				`302 -> ${objRes.status}, bytes ${match ? 'match' : 'MISMATCH'}`,
			);
		} else {
			record('FAIL', 'blob read back', `expected 302, got ${readRes.status}`);
		}

		// Cleanup the uploaded object (idempotent).
		await fetch(API_ROUTES.blobs.byHash.url(BASE_URL, owner, sha256), {
			method: 'DELETE',
			headers: authHeaders,
		});
	}

	return summarize();
}

function summarize() {
	const counts = rows.reduce(
		(acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }),
		{} as Record<Status, number>,
	);
	console.log(
		`\nSummary: ${counts.PASS ?? 0} pass, ${counts.FAIL ?? 0} fail, ${counts.SKIP ?? 0} skip\n`,
	);
	process.exit((counts.FAIL ?? 0) > 0 ? 1 : 0);
}

await main();
