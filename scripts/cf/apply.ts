#!/usr/bin/env bun
/**
 * Reconcile Cloudflare zone settings, DNSSEC, email DNS, and redirect rules
 * across every zone we own. Idempotent: reads current values, diffs, writes
 * only what differs. Safe to re-run any time.
 *
 *   bun run cf:plan   preview; exits 2 if drift detected (CI signal)
 *   bun run cf:apply  write changes
 *
 * Token: CLOUDFLARE_ZONE_TOKEN with zone-level scopes on all zones:
 * Zone:Read, Zone Settings:Edit, DNS:Edit, Dynamic Redirect:Edit (older
 * docs call this last one "Single Redirect"; same permission). Create at
 * https://dash.cloudflare.com/profile/api-tokens.
 *
 * Adding a zone: add the domain to `ZONES` below. Zones marked `lockdown`
 * get SPF `-all` + DMARC `p=reject` so they cannot be used to spoof mail;
 * zones marked `managed-externally` (today only epicenter.so via Google
 * Workspace) have their email DNS left alone. Add a `redirects` field to
 * a zone entry to manage Cloudflare Single Redirect rules for that zone.
 */

import { APPS } from '@epicenter/constants/apps';

type RedirectConfig = {
	ref: string;
	description: string;
	hosts: readonly string[];
	targetUrl: string;
	statusCode: number;
	preserveQueryString: boolean;
};

type ZoneConfig = {
	name: string;
	email: 'managed-externally' | 'lockdown';
	redirects?: readonly RedirectConfig[];
};

const ZONES: readonly ZoneConfig[] = [
	{ name: 'epicenter.so', email: 'managed-externally' }, // Google Workspace
	{ name: 'epicenter.sh', email: 'lockdown' },
	{ name: 'epicenter.audio', email: 'lockdown' },
	{ name: 'epicenter.build', email: 'lockdown' },
	{ name: 'epicenter.chat', email: 'lockdown' },
	{ name: 'epicenter.email', email: 'lockdown' },
	{ name: 'epicenter.md', email: 'lockdown' },
	{ name: 'epicenter.social', email: 'lockdown' },
	{ name: 'getepicenter.com', email: 'lockdown' },
	{
		name: 'getwhispering.com',
		email: 'lockdown',
		redirects: [
			{
				ref: 'whispering_legacy_getwhispering_to_epicenter',
				description:
					'Redirect legacy Whispering domain to Epicenter product page',
				hosts: ['getwhispering.com', 'www.getwhispering.com'],
				targetUrl: 'https://epicenter.so/whispering',
				statusCode: 301,
				preserveQueryString: false,
			},
		],
	},
	{ name: 'opensidian.com', email: 'lockdown' },
	{
		name: 'whispering.studio',
		email: 'lockdown',
		redirects: [
			{
				ref: 'whispering_legacy_studio_to_epicenter',
				description:
					'Redirect legacy Whispering studio domain to Epicenter product page',
				hosts: ['whispering.studio', 'www.whispering.studio'],
				targetUrl: 'https://epicenter.so/whispering',
				statusCode: 301,
				preserveQueryString: false,
			},
		],
	},
];

const ZONE_BASELINE = {
	always_use_https: 'on',
	automatic_https_rewrites: 'on',
	ssl: 'strict',
	min_tls_version: '1.2',
	security_header: {
		strict_transport_security: {
			enabled: true,
			max_age: 15_552_000, // 180 days; revisit preload after 6-12 months stable
			include_subdomains: true,
			preload: false,
			nosniff: true,
		},
	},
} as const;

const REDIRECT_RULESET_PHASE = 'http_request_dynamic_redirect';
// RFC 5737 documentation address. Cloudflare applies Single Redirects at the
// proxy edge, so this IP is never actually contacted: it exists only to make
// the hostname proxiable.
const REDIRECT_PLACEHOLDER_IP = '192.0.2.1';

const CF_API = 'https://api.cloudflare.com/client/v4';
const token = process.env.CLOUDFLARE_ZONE_TOKEN;

if (!token) {
	console.error(
		'CLOUDFLARE_ZONE_TOKEN is not set. Create one at https://dash.cloudflare.com/profile/api-tokens',
	);
	console.error(
		'Required zone-level scopes (all zones): Zone:Read, Zone Settings:Edit, DNS:Edit, Dynamic Redirect:Edit (sometimes labeled "Single Redirect" in older docs).',
	);
	process.exit(1);
}

/**
 * Cloudflare API envelope. Every response uses this shape; `result` is the
 * endpoint-specific payload that callers cast via `as T`.
 */
type CfResponse = {
	success: boolean;
	result: unknown;
	errors?: Array<{ code: number; message: string }>;
};

/**
 * Bearer-authed JSON fetch against the Cloudflare API. Returns the raw
 * envelope so callers can branch on status (e.g., treat 404 as "not yet
 * created") before deciding whether the response is an error.
 */
async function cfRequest(method: string, path: string, body?: unknown) {
	const res = await fetch(`${CF_API}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return {
		status: res.status,
		ok: res.ok,
		json: (await res.json()) as CfResponse,
	};
}

/**
 * Throw a Cloudflare error with HTTP status and any Cloudflare error codes
 * concatenated. Return type `never` lets callers use it as a terminator
 * (`if (...) cfFail(...)`) without TypeScript thinking the value is still
 * defined afterwards.
 */
function cfFail(
	method: string,
	path: string,
	status: number,
	json: CfResponse,
): never {
	const errs = json.errors?.map((e) => `[${e.code}] ${e.message}`).join('; ');
	throw new Error(
		`Cloudflare ${method} ${path} failed (${status}): ${errs ?? 'unknown error'}`,
	);
}

/**
 * Call Cloudflare and return the typed `result`. Throws on any non-success
 * response (including 404). Use a direct `cfRequest` call if 404 is a
 * legitimate "not created yet" signal instead of an error.
 */
async function cf<T>(method: string, path: string, body?: unknown): Promise<T> {
	const { status, ok, json } = await cfRequest(method, path, body);
	if (!ok || !json.success) cfFail(method, path, status, json);
	return json.result as T;
}

// Cross-check: every APPS URL must live on a declared zone. Adding an app on
// a new domain without first declaring its zone fails the script loudly here
// instead of silently leaving that zone unmanaged.
const orphans: string[] = [];
for (const [id, app] of Object.entries(APPS)) {
	for (const url of app.urls) {
		const host = new URL(url).hostname;
		const onZone = ZONES.some(
			(z) => host === z.name || host.endsWith(`.${z.name}`),
		);
		if (!onZone) orphans.push(`APPS.${id}: ${url}`);
	}
}
if (orphans.length > 0) {
	console.error(
		`URLs in APPS are not on any declared zone:\n  ${orphans.join('\n  ')}`,
	);
	console.error('Add the zone to ZONES in scripts/cf/apply.ts or fix the URL.');
	process.exit(1);
}

const isPlan = process.argv.includes('--plan');
const tag = isPlan ? '[plan]' : '[apply]';
let drift = 0;
const dsRecords: Array<{ zone: string; ds: string }> = [];

console.log(
	`${tag} Cloudflare baseline reconciliation across ${ZONES.length} zones`,
);

for (const zone of ZONES) {
	console.log(`\n==> ${zone.name} (email: ${zone.email})`);

	const [match] = await cf<Array<{ id: string }>>(
		'GET',
		`/zones?name=${encodeURIComponent(zone.name)}`,
	);
	if (!match) {
		console.error('    SKIP: zone not found. Add to Cloudflare account first.');
		drift++;
		continue;
	}
	const zoneId = match.id;

	for (const [id, want] of Object.entries(ZONE_BASELINE)) {
		const got = await cf<{ value: unknown }>(
			'GET',
			`/zones/${zoneId}/settings/${id}`,
		);
		if (deepEqual(got.value, want)) {
			console.log(`    ok      ${id}`);
			continue;
		}
		drift++;
		console.log(
			`    diff    ${id}: ${shortJson(got.value)} -> ${shortJson(want)}`,
		);
		if (!isPlan) {
			await cf('PATCH', `/zones/${zoneId}/settings/${id}`, { value: want });
			console.log(`    applied ${id}`);
		}
	}

	const dnssec = await cf<{ status: string; ds?: string }>(
		'GET',
		`/zones/${zoneId}/dnssec`,
	);
	if (dnssec.status !== 'active') {
		drift++;
		console.log(`    diff    dnssec: ${dnssec.status} -> active`);
		if (!isPlan) {
			const updated = await cf<{ status: string; ds?: string }>(
				'PATCH',
				`/zones/${zoneId}/dnssec`,
				{ status: 'active' },
			);
			console.log('    applied dnssec');
			if (updated.ds) {
				dsRecords.push({ zone: zone.name, ds: updated.ds });
			} else {
				console.log(
					`    note    dnssec is "${updated.status}"; DS record not yet returned. Re-run cf:plan once status flips to "active" to print the DS for the registrar.`,
				);
			}
		}
	} else {
		console.log('    ok      dnssec');
		if (dnssec.ds) dsRecords.push({ zone: zone.name, ds: dnssec.ds });
	}

	if (zone.redirects?.length) {
		for (const redirect of zone.redirects) {
			for (const host of redirect.hosts) {
				await reconcileRedirectDnsRecord(zone.name, zoneId, host);
			}
		}
		await reconcileRedirectRuleset(zoneId, zone.redirects);
	}

	if (zone.email !== 'lockdown') {
		console.log('    skip    email DNS (managed externally)');
		continue;
	}
	const lockdownRecords = [
		{ type: 'TXT', name: zone.name, content: 'v=spf1 -all', ttl: 3600 },
		{
			type: 'TXT',
			name: `_dmarc.${zone.name}`,
			content:
				'v=DMARC1; p=reject; rua=mailto:postmaster@epicenter.so; aspf=s; adkim=s',
			ttl: 3600,
		},
	];
	for (const want of lockdownRecords) {
		const existing = await cf<Array<{ id: string; content: string }>>(
			'GET',
			`/zones/${zoneId}/dns_records?type=TXT&name=${encodeURIComponent(want.name)}`,
		);
		const isSpf = want.content.startsWith('v=spf1');
		const label = isSpf ? 'spf' : 'dmarc';
		const prefix = isSpf ? 'v=spf1' : 'v=DMARC1';
		const candidates = existing.filter((r) => r.content.startsWith(prefix));
		if (candidates.length > 1) {
			// SPF or DMARC duplicates cause receivers to reject the domain. The
			// script reconciles the first match; you must delete the rest by hand.
			console.log(
				`    warn    ${candidates.length} ${label} records on ${want.name}; mail receivers will reject this zone. Delete duplicates in the Cloudflare dashboard.`,
			);
		}
		const match = candidates[0];
		if (match?.content === want.content) {
			console.log(`    ok      txt ${label} ${want.name}`);
			continue;
		}
		drift++;
		if (match) {
			console.log(
				`    diff    txt ${label} ${want.name}:\n              from: ${match.content}\n              to:   ${want.content}`,
			);
			if (!isPlan) {
				await cf('PUT', `/zones/${zoneId}/dns_records/${match.id}`, want);
				console.log(`    applied txt ${label} ${want.name}`);
			}
		} else {
			console.log(`    create  txt ${label} ${want.name}: ${want.content}`);
			if (!isPlan) {
				await cf('POST', `/zones/${zoneId}/dns_records`, want);
				console.log(`    applied txt ${label} ${want.name}`);
			}
		}
	}
}

console.log(`\n${tag} done. ${drift} drift item(s).`);

if (dsRecords.length > 0) {
	console.log(
		'\nDS records (paste at registrar for any zone NOT registered at Cloudflare):',
	);
	for (const { zone, ds } of dsRecords) console.log(`  ${zone}: ${ds}`);
}

if (isPlan && drift > 0) process.exit(2);

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (
		typeof a !== typeof b ||
		typeof a !== 'object' ||
		a === null ||
		b === null
	) {
		return false;
	}
	const ak = Object.keys(a as object);
	const bk = Object.keys(b as object);
	if (ak.length !== bk.length) return false;
	return ak.every((k) =>
		deepEqual(
			(a as Record<string, unknown>)[k],
			(b as Record<string, unknown>)[k],
		),
	);
}

function shortJson(v: unknown): string {
	const s = JSON.stringify(v);
	return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

/**
 * Make sure `host` has a proxied DNS record so Cloudflare's redirect rules
 * actually run. Three outcomes:
 *
 *   1. Any proxied A/AAAA/CNAME exists, leave it alone (someone else owns
 *      the origin; redirect rules still apply on top).
 *   2. Our placeholder A exists but isn't proxied, flip it.
 *   3. No address record exists, create the placeholder. If a non-proxied
 *      address record points somewhere else, warn instead of clobbering.
 *
 * TXT/MX/etc. records at the same name are intentionally ignored: they
 * don't affect HTTP routing and coexist fine with a proxied A. Filtering
 * them out is what fixes the "SPF blocks redirect setup" bug at the apex.
 */
async function reconcileRedirectDnsRecord(
	zoneName: string,
	zoneId: string,
	host: string,
) {
	const records = await cf<
		Array<{ id: string; type: string; content: string; proxied?: boolean }>
	>('GET', `/zones/${zoneId}/dns_records?name=${encodeURIComponent(host)}`);
	const addressRecords = records.filter(
		(record) =>
			record.type === 'A' || record.type === 'AAAA' || record.type === 'CNAME',
	);

	const usable = addressRecords.find((record) => record.proxied === true);
	if (usable) {
		console.log(`    ok      redirect dns ${host}`);
		return;
	}

	const placeholder = addressRecords.find(
		(record) =>
			record.type === 'A' && record.content === REDIRECT_PLACEHOLDER_IP,
	);
	const want = {
		type: 'A',
		name: host,
		content: REDIRECT_PLACEHOLDER_IP,
		ttl: 1,
		proxied: true,
	};
	if (placeholder) {
		drift++;
		console.log(`    diff    redirect dns ${host}: proxied false -> true`);
		if (!isPlan) {
			await cf('PUT', `/zones/${zoneId}/dns_records/${placeholder.id}`, want);
			console.log(`    applied redirect dns ${host}`);
		}
		return;
	}

	if (addressRecords.length > 0) {
		drift++;
		const summary = addressRecords
			.map((r) => `${r.type} ${r.content} proxied=${r.proxied ?? false}`)
			.join(', ');
		console.log(
			`    warn    redirect dns ${host}: conflicting address records [${summary}] block Cloudflare redirects. Reconcile in the dashboard before re-running.`,
		);
		return;
	}

	drift++;
	const label = host === zoneName ? '@' : host.slice(0, -zoneName.length - 1);
	console.log(
		`    create  redirect dns ${label}: A ${REDIRECT_PLACEHOLDER_IP} proxied`,
	);
	if (!isPlan) {
		await cf('POST', `/zones/${zoneId}/dns_records`, want);
		console.log(`    applied redirect dns ${host}`);
	}
}

// Cloudflare returns extra read-only fields on rules (`version`,
// `last_updated`, `categories`, etc.) that get rejected if echoed back on
// PUT. `ApiRule` lists only the fields this script reads or writes; unknown
// fields are stripped via `projectRule` before we send the array.
type ApiRule = {
	id?: string;
	ref?: string;
	description?: string;
	expression: string;
	action: string;
	action_parameters?: unknown;
	enabled: boolean;
};

type ApiRuleset = {
	id: string;
	name: string;
	kind: string;
	phase: string;
	rules: ApiRule[];
};

/**
 * Reconcile the zone-level Single Redirect ruleset against `redirects`.
 *
 * If no ruleset exists for the dynamic-redirect phase, POST a fresh one.
 * Otherwise, identify our managed rules by `ref`, upsert ours, and pass
 * unrelated rules through untouched so a dashboard-added rule is not
 * clobbered. Every PUT/POST body is projected through `projectRule` to
 * strip server-only fields that Cloudflare rejects on write.
 */
async function reconcileRedirectRuleset(
	zoneId: string,
	redirects: readonly RedirectConfig[],
) {
	// A 404 on the phase entrypoint means "no ruleset yet", not an error.
	// Inline the optional fetch rather than ship a one-call-site helper.
	const path = `/zones/${zoneId}/rulesets/phases/${REDIRECT_RULESET_PHASE}/entrypoint`;
	const { status, ok, json } = await cfRequest('GET', path);
	if (status !== 404 && (!ok || !json.success)) {
		cfFail('GET', path, status, json);
	}
	const existing = status === 404 ? null : (json.result as ApiRuleset);

	const desiredRules: ApiRule[] = redirects.map((redirect) => ({
		ref: redirect.ref,
		description: redirect.description,
		expression: `(${redirect.hosts.map((h) => `http.host eq "${h}"`).join(' or ')})`,
		action: 'redirect',
		action_parameters: {
			from_value: {
				target_url: { value: redirect.targetUrl },
				status_code: redirect.statusCode,
				preserve_query_string: redirect.preserveQueryString,
			},
		},
		enabled: true,
	}));

	if (!existing) {
		drift++;
		console.log(`    create  redirect ruleset ${REDIRECT_RULESET_PHASE}`);
		if (!isPlan) {
			await cf('POST', `/zones/${zoneId}/rulesets`, {
				name: 'Redirect rules',
				kind: 'zone',
				phase: REDIRECT_RULESET_PHASE,
				rules: desiredRules.map(projectRule),
			});
			console.log('    applied redirect ruleset');
		}
		return;
	}

	// Preserve unrelated rules (anything we don't manage by ref): start from
	// existing rules and upsert ours by ref.
	const rules: ApiRule[] = [...existing.rules];
	let changed = false;
	for (const desired of desiredRules) {
		const index = rules.findIndex((rule) => rule.ref === desired.ref);
		if (index === -1) {
			changed = true;
			rules.push(desired);
			console.log(`    create  redirect rule ${desired.ref}`);
			continue;
		}
		const current = rules[index];
		if (!current) throw new Error(`Missing redirect rule at index ${index}`);
		const merged: ApiRule = { ...desired, id: current.id };
		if (deepEqual(projectRule(current), projectRule(merged))) {
			console.log(`    ok      redirect rule ${desired.ref}`);
			continue;
		}
		changed = true;
		rules[index] = merged;
		console.log(`    diff    redirect rule ${desired.ref}`);
	}

	if (!changed) return;
	drift++;
	if (!isPlan) {
		await cf('PUT', `/zones/${zoneId}/rulesets/${existing.id}`, {
			name: existing.name,
			kind: existing.kind,
			phase: existing.phase,
			rules: rules.map(projectRule),
		});
		console.log('    applied redirect ruleset');
	}
}

/**
 * Single projection used both as the PUT body and as the comparison shape.
 *
 * Cloudflare returns extra read-only fields on rules (`version`,
 * `last_updated`, `categories`, ...) that get rejected if echoed back on
 * PUT, and that also make `deepEqual` against our locally-constructed
 * rules report false drift. Both problems are solved by one projection.
 *
 * `id` flows through: Cloudflare uses it to match the existing rule on
 * PUT, and it's always set on both sides of a comparison (the API returns
 * it on `current`, and we copy it via `{ ...desired, id: current.id }`).
 */
function projectRule(rule: ApiRule): ApiRule {
	return {
		id: rule.id,
		ref: rule.ref,
		description: rule.description,
		expression: rule.expression,
		action: rule.action,
		action_parameters: rule.action_parameters,
		enabled: rule.enabled,
	};
}
