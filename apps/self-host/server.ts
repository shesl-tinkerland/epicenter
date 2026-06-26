/**
 * Bun entry for apps/self-host: the off-Cloudflare self-host deployable.
 *
 * The off-Cloudflare twin of `worker/index.ts`. It builds the SAME
 * `createServerApp(...)` the Worker builds, but binds the per-concern runtime
 * hooks to plain primitives instead of Cloudflare bindings (ADR-0066):
 *
 *   - `connectDb`     a module-scope `pg.Pool` over `DATABASE_URL`
 *   - `afterResponse` fire-and-forget in the live process (no `waitUntil`)
 *   - `resolveRooms`  an in-process registry over `bun:sqlite` files
 *
 * This is the "one binary + Postgres, no Cloudflare account" self-host artifact:
 * `bun server.ts` (or a `bun build --compile` binary) is a complete box on a
 * single node. Rooms are `bun:sqlite` files on local disk, so this is a
 * single-node deployment by design: it does not shard or hibernate per room the
 * way the Durable Object edge does, which is exactly right for one homelab or
 * one community's wiki and the price of owning your own data on your own machine.
 *
 * The box's shape is an explicit launch choice (`EPICENTER_MODE`), never sniffed
 * from which secrets happen to be set (ADR-0072). The partition IS durable data,
 * so deriving it from mutable OAuth credentials would let adding or rotating a
 * secret silently re-partition a running box; an explicit mode makes that a
 * deliberate re-provision instead. The configured OAuth providers must AGREE with
 * the declared mode, and that agreement is checked loudly at boot.
 *
 *   - `EPICENTER_MODE=shared` -> shared wiki (Config D): `shared({ admit })`,
 *     every authenticated user shares the SHARED_OWNER_ID partition, gated by the
 *     `ALLOWED_MEMBER_EMAILS` allowlist, and the configured OAuth providers
 *     authenticate. Requires at least one provider.
 *   - unset / `EPICENTER_MODE=solo` -> solo box (Config A): `personal()`, the
 *     single owner authenticates with a first-boot bearer the box mints and saves
 *     0600 (named, never echoed to the logs; ADR-0072), so a homelab needs no
 *     OAuth app to reach its own data.
 *
 * Surface mirrors the Worker self-host: session + rooms + inference, zero
 * billing, no dashboard SPA. Blobs are intentionally not mounted; add
 * `mountBlobsApp` with `BLOBS_S3_*` set to offer a content-addressed media store
 * against any S3 (proven portable on Bun by the apps/api runtime-parity smoke).
 *
 * The wiring lives in {@link startSelfHostServer} so `server.dev.ts` can boot the
 * SAME server with a dev `resolveUser` injected (the smoke's credential) without
 * duplicating it. Production runs only when this file IS the entrypoint
 * (`import.meta.main`), so `server.dev.ts` importing the builder does not start a
 * second listener. Production passes no `resolveUser` and keeps the mode's own
 * resolver (OAuth for a wiki, the bearer for a solo box); this file never imports
 * the dev bypass.
 */

import { AuthUser, asUserId } from '@epicenter/auth';
import {
	BunHostBindings,
	configuredSocialProviders,
	createInstanceTokenResolver,
	incompleteSocialProviders,
	personal,
	resolveDataDir,
	type ResolveUser,
	shared,
	startBunServer,
} from '@epicenter/server/bun';
import { type } from 'arktype';
import { loadOrMintInstanceToken } from './instance-token.js';

/**
 * The solo box's single owner id. Byte-pinned and permanent: `personal()` keys
 * the owner partition (the R2/DO/IDB prefix) by it, so it is durable data like
 * SHARED_OWNER_ID. Chosen once, never changed (ADR-0072): changing it would
 * re-partition every byte the box already stored.
 */
const INSTANCE_OWNER_ID = asUserId('self-host');

/**
 * Boot the apps/self-host Bun server, optionally with an injected user resolver.
 *
 * Production (`server.ts` as the entrypoint) passes nothing, so the box runs the
 * mode `EPICENTER_MODE` declares: OAuth for a wiki, the first-boot bearer for a
 * solo box. `server.dev.ts` passes a dev `Bearer dev:<userId>` resolver so the
 * smoke needs no interactive login. Everything else (env validation, pool, rooms,
 * mounts, `Bun.serve`) is identical across the two, so they cannot drift.
 */
export function startSelfHostServer(
	opts: { resolveUser?: ResolveUser } = {},
): void {
	// Validate this host's environment once, at boot (ADR-0066): the library's
	// portable secrets (`BunHostBindings` extends `ServerBindings`), this host's
	// own config, the declared `EPICENTER_MODE`, the shared-wiki membership
	// allowlist, and the optional `INSTANCE_TOKEN` override for the solo bearer.
	// A misconfiguration gets ONE
	// descriptive error naming every missing or malformed var instead of a
	// downstream surprise. The validated result IS the typed env handed to the
	// Hono app: no `as`-cast over `process.env`, no lie. Unlike the Cloudflare
	// edge (whose bindings are deploy-gated and `wrangler types`-typed),
	// `process.env` is unchecked, so boot is the place to validate it.
	const env = BunHostBindings.merge({
		// The deployment's declared shape, an explicit launch choice (ADR-0072):
		// `shared` is a wiki (OAuth + allowlist), unset or `solo` is the
		// single-owner homelab box. Never derived from which secrets are set, so a
		// credential change cannot silently re-partition a running box; an invalid
		// value fails boot via the validator below.
		'EPICENTER_MODE?': "'solo' | 'shared'",
		// Comma-separated emails admitted to the shared wiki. Optional so boot never
		// fails on it; an unset allowlist admits nobody (fail closed, below).
		'ALLOWED_MEMBER_EMAILS?': 'string',
		// The solo box's bearer, when an operator injects it (12-factor / container
		// secret) instead of letting the box mint and persist its own.
		'INSTANCE_TOKEN?': 'string',
	})(process.env);
	if (env instanceof type.errors) {
		console.error(
			`Invalid environment for the self-host server:\n${env.summary}`,
		);
		process.exit(1);
	}

	// A self-host trusts its OWN origin and the Tauri desktop client, never
	// Epicenter cloud's. Same in both modes.
	const resolveTrustedOrigins = (baseURL: string) => [
		new URL(baseURL).origin,
		'tauri://localhost',
	];

	// The declared mode. Unset is the zero-config solo homelab; `shared` is a wiki.
	const mode = env.EPICENTER_MODE ?? 'solo';

	// Fail loud when the configured credentials contradict the declared mode,
	// instead of silently resolving it (the old provider-sniffing selector would
	// boot the "wrong" mode on a typo, and because mode IS the data partition,
	// that silently re-partitioned the box). Each check names the fix.
	const fail = (reason: string): never => {
		console.error(`Invalid configuration for the self-host server:\n  ${reason}`);
		process.exit(1);
	};
	const halfConfigured = incompleteSocialProviders(env);
	if (halfConfigured.length > 0) {
		fail(
			`${halfConfigured.join(', ')} ${halfConfigured.length > 1 ? 'each have' : 'has'} only one of client id / secret set; set both or neither.`,
		);
	}
	const oauthProviders = Object.keys(configuredSocialProviders(env));
	const hasAllowlist = Boolean(env.ALLOWED_MEMBER_EMAILS?.trim());
	if (mode === 'shared' && oauthProviders.length === 0) {
		fail(
			'EPICENTER_MODE=shared is a wiki but no OAuth provider is configured; set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET (or GITHUB_*).',
		);
	}
	if (mode === 'solo' && oauthProviders.length > 0) {
		fail(
			`Solo mode runs no OAuth, but ${oauthProviders.join(', ')} ${oauthProviders.length > 1 ? 'are' : 'is'} configured; set EPICENTER_MODE=shared to run a wiki, or remove the OAuth credentials.`,
		);
	}
	if (mode === 'solo' && hasAllowlist) {
		fail(
			'Solo mode has no members to admit, but ALLOWED_MEMBER_EMAILS is set; set EPICENTER_MODE=shared, or remove the allowlist.',
		);
	}

	if (mode === 'shared') {
		// Shared wiki (Config D). Parse the allowlist once at boot and close over the
		// set, so admit is a plain membership test with no per-request env read. An
		// unset or empty var yields an empty set: the deployment admits nobody until
		// the operator names members, so a missing allowlist fails closed rather than
		// opening the wiki to every account the providers would authenticate.
		const allowedMembers = new Set(
			(env.ALLOWED_MEMBER_EMAILS ?? '')
				.split(',')
				.map((email) => email.trim())
				.filter(Boolean),
		);
		const { origin, dataDir } = startBunServer({
			env,
			defaultPort: 8787,
			mode: 'shared',
			ownership: shared({
				admit: (c) => allowedMembers.has(c.var.user.email),
			}),
			resolveTrustedOrigins,
			// Undefined in production (the real OAuth resolver); server.dev.ts injects
			// a dev bearer resolver.
			resolveUser: opts.resolveUser,
		});
		console.log(
			`apps/self-host (Bun) listening on ${origin} (rooms in ${dataDir})\n` +
				`shared-wiki mode (EPICENTER_MODE=shared): OAuth providers ${oauthProviders.join(', ')}, ${allowedMembers.size} member(s) admitted`,
		);
		return;
	}

	// Solo box (Config A). EPICENTER_MODE is unset or `solo`, so the single owner
	// authenticates with a first-boot bearer. A dev entry may inject its own
	// resolver (the smoke's dev bearer); only then do we skip minting, so a dev run
	// never writes a token file. Otherwise mint/persist the token (an
	// INSTANCE_TOKEN override wins) and build the instance-token resolver as the
	// one total gate.
	let resolveUser = opts.resolveUser;
	let instance: ReturnType<typeof loadOrMintInstanceToken> | undefined;
	if (!resolveUser) {
		instance = loadOrMintInstanceToken({
			// Same resolver startBunServer uses for the rooms dir, so the token and
			// the rooms always share one directory and one fate (no cwd-vs-DATA_DIR
			// split that strands the token when only the rooms volume is persisted).
			dataDir: resolveDataDir(env),
			envToken: env.INSTANCE_TOKEN,
		});
		resolveUser = createInstanceTokenResolver({
			token: instance.token,
			user: AuthUser.assert({
				id: INSTANCE_OWNER_ID,
				email: 'owner@self-host.local',
			}),
		});
	}

	const { origin, dataDir } = startBunServer({
		env,
		defaultPort: 8787,
		mode: 'solo',
		ownership: personal(),
		resolveTrustedOrigins,
		resolveUser,
	});

	// Boot banner. NEVER echo the token to the logs (journald / docker logs are a
	// worse at-rest location than the 0600 file, and are retained and shipped);
	// name the file in both the freshly-minted and reused cases, and let the
	// operator `cat` it once. A re-mint (the operator forgot to persist DATA_DIR)
	// is still visible because the "minted" banner differs from the "loaded" one.
	const banner = `apps/self-host (Bun) listening on ${origin} (rooms in ${dataDir})`;
	if (!instance) {
		console.log(`${banner}\nsolo mode (dev resolver injected)`);
	} else if (instance.minted) {
		console.log(
			`${banner}\nsolo mode. Minted a new instance token, saved 0600 to ${instance.path}.\n` +
				`Read it once and paste it into the client instance setting:\n  cat ${instance.path}`,
		);
	} else {
		console.log(
			`${banner}\nsolo mode. Instance token loaded from ${instance.path} (view: cat ${instance.path})`,
		);
	}
}

// Run production only when this file is the entrypoint. `server.dev.ts` imports
// `startSelfHostServer` to boot the dev variant, and must not trigger a second
// listener here.
if (import.meta.main) startSelfHostServer();
