/**
 * One-scenario smoke for the self-host shared-wiki deployable. Same backend,
 * either runtime (the Bun entry or the wrangler Worker).
 *
 * Unlike the apps/api smoke (personal mode, every authed user is always their
 * own owner), this proves the shared-mode admission gate BOTH ways:
 *   - an allowlisted member resolves the SHARED_OWNER_ID partition and opens a
 *     room (admit -> 200)
 *   - a stranger is rejected at the boundary (403 NotAdmitted), before any room
 *     is touched
 *
 * Auth is the one thing the scenario cannot get over plain HTTP, so it relies on
 * the server running with the dev resolver injected AND a matching allowlist.
 * The entry selects shared-wiki mode when an OAuth provider is configured, so
 * set dummy Google creds to request that mode; the dev resolver bypasses the
 * real handshake, so the creds are never used for an actual sign-in:
 *
 *   GOOGLE_CLIENT_ID=dev GOOGLE_CLIENT_SECRET=dev \
 *     ALLOWED_MEMBER_EMAILS=tester@dev.invalid bun run dev:bun:devauth
 *
 * The dev resolver maps `Authorization: Bearer dev:<id>` to `<id>@dev.invalid`,
 * so `dev:tester` is admitted and `dev:intruder` is not. Point this at the
 * resulting server:
 *
 *   bun apps/self-host/scripts/smoke.ts http://localhost:8789
 */

import { API_ROUTES } from '@epicenter/constants/api-routes';

const BASE_URL = (
	process.argv[2] ??
	process.env.BASE_URL ??
	'http://localhost:8789'
).replace(/\/+$/, '');

// `tester@dev.invalid` must be in the server's ALLOWED_MEMBER_EMAILS; the
// stranger's `intruder@dev.invalid` must not be. SHARED_OWNER_ID is the literal
// 'shared' (see @epicenter/identity), which is the partition a member resolves.
const MEMBER_ID = 'tester';
const STRANGER_ID = 'intruder';
const SHARED_PARTITION = 'shared';

function bearer(id: string): Record<string, string> {
	return { authorization: `Bearer dev:${id}` };
}

type Status = 'PASS' | 'FAIL';
const rows: { status: Status; step: string; detail: string }[] = [];
function record(status: Status, step: string, detail: string): void {
	rows.push({ status, step, detail });
	console.log(`  [${status}] ${step.padEnd(26)} ${detail}`);
}

function randHex(bytes: number): string {
	return [...crypto.getRandomValues(new Uint8Array(bytes))]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

function summarize(): never {
	const pass = rows.filter((r) => r.status === 'PASS').length;
	const fail = rows.filter((r) => r.status === 'FAIL').length;
	console.log(`\nSummary: ${pass} pass, ${fail} fail\n`);
	process.exit(fail ? 1 : 0);
}

async function main() {
	console.log(`\nSelf-host shared-mode smoke against ${BASE_URL}\n`);

	// 1. Health (no auth). Reports the mode + runtime that answered.
	try {
		const res = await fetch(`${BASE_URL}/`);
		const body = (await res.json()) as { mode?: string; runtime?: string };
		record(
			res.ok ? 'PASS' : 'FAIL',
			'health',
			`${res.status} mode=${body.mode ?? '?'} runtime=${body.runtime ?? '?'}`,
		);
	} catch (err) {
		record('FAIL', 'health', `unreachable: ${(err as Error).message}`);
		return summarize();
	}

	// 2. Member session: admit passes, the resolved partition is SHARED_OWNER_ID.
	let ownerId = '';
	{
		const res = await fetch(API_ROUTES.session.url(BASE_URL), {
			headers: bearer(MEMBER_ID),
		});
		if (res.ok) {
			ownerId = ((await res.json()) as { ownerId: string }).ownerId;
			record(
				ownerId === SHARED_PARTITION ? 'PASS' : 'FAIL',
				'member session',
				`${res.status} ownerId=${ownerId} (expected ${SHARED_PARTITION})`,
			);
		} else {
			record('FAIL', 'member session', `${res.status} ${await res.text()}`);
			return summarize();
		}
	}

	// 3. Member opens a room under the shared partition (create-on-first-touch).
	{
		const roomId = `smoke-${randHex(4)}`;
		const url = `${BASE_URL}/api/owners/${encodeURIComponent(ownerId)}/rooms/${roomId}?nodeId=smoke`;
		const res = await fetch(url, { headers: bearer(MEMBER_ID) });
		const buf = await res.arrayBuffer();
		record(
			res.ok ? 'PASS' : 'FAIL',
			'member room open+read',
			`${res.status} doc=${buf.byteLength}B`,
		);
	}

	// 4. Stranger session: admit denies at the boundary (403 NotAdmitted) before
	// any partition is resolved. This is the gate the personal-mode smoke cannot
	// exercise.
	{
		const res = await fetch(API_ROUTES.session.url(BASE_URL), {
			headers: bearer(STRANGER_ID),
		});
		record(
			res.status === 403 ? 'PASS' : 'FAIL',
			'stranger rejected',
			`${res.status} (expected 403 NotAdmitted)`,
		);
	}

	summarize();
}

main();
