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
 * The box recomputes its shape from one input, with no stored mode discriminator
 * (ADR-0071): the set of configured OAuth providers. That set is the SAME one
 * `createAuth` registers (configuredSocialProviders), so the gate can never
 * disagree with what actually accepts a sign-in.
 *
 *   - any provider configured -> shared wiki (Config D): `shared({ admit })`,
 *     every authenticated user shares the SHARED_OWNER_ID partition, gated by the
 *     `ALLOWED_MEMBER_EMAILS` allowlist, and the real OAuth resolver authenticates.
 *   - none configured         -> solo box (Config A): `personal()`, the single
 *     owner authenticates with a first-boot bearer the box mints and prints once
 *     (ADR-0072), so a homelab needs no Google app to reach its own data.
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
 * second listener. Production passes no `resolveUser` and keeps the recomputed
 * resolver; this file never imports the dev bypass.
 */

import { AuthUser, asUserId } from '@epicenter/auth';
import {
	BunHostBindings,
	configuredSocialProviders,
	createInstanceTokenResolver,
	personal,
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
 * Production (`server.ts` as the entrypoint) passes nothing, so the entry
 * recomputes the resolver from the configured providers (OAuth for a wiki, the
 * first-boot bearer for a solo box). `server.dev.ts` passes a dev
 * `Bearer dev:<userId>` resolver so the smoke needs no interactive login.
 * Everything else (env validation, pool, rooms, mounts, `Bun.serve`) is identical
 * across the two, so they cannot drift.
 */
export function startSelfHostServer(
	opts: { resolveUser?: ResolveUser } = {},
): void {
	// Validate this host's environment once, at boot (ADR-0066): the library's
	// portable secrets (`BunHostBindings` extends `ServerBindings`), this host's
	// own config, the shared-wiki membership allowlist, and the optional
	// `INSTANCE_TOKEN` override for the solo bearer. A misconfiguration gets ONE
	// descriptive error naming every missing or malformed var instead of a
	// downstream surprise. The validated result IS the typed env handed to the
	// Hono app: no `as`-cast over `process.env`, no lie. Unlike the Cloudflare
	// edge (whose bindings are deploy-gated and `wrangler types`-typed),
	// `process.env` is unchecked, so boot is the place to validate it.
	const env = BunHostBindings.merge({
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

	// The selector: the set of configured OAuth providers, recomputed from inputs.
	const oauthProviders = Object.keys(configuredSocialProviders(env));

	if (oauthProviders.length > 0) {
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
				`OAuth providers ${oauthProviders.join(', ')} -> shared-wiki mode, ${allowedMembers.size} member(s) admitted`,
		);
		return;
	}

	// Solo box (Config A). No OAuth provider is configured, so the single owner
	// authenticates with a first-boot bearer. A dev entry may inject its own
	// resolver (the smoke's dev bearer); only then do we skip minting, so a dev run
	// never writes a token file. Otherwise mint/persist the token (an
	// INSTANCE_TOKEN override wins) and build the instance-token resolver as the
	// one total gate.
	let resolveUser = opts.resolveUser;
	let instance: ReturnType<typeof loadOrMintInstanceToken> | undefined;
	if (!resolveUser) {
		instance = loadOrMintInstanceToken({
			dataDir: env.DATA_DIR ?? '.',
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

	// Boot banner. Print the minted token ONCE; on later boots name the file
	// instead, so the secret is not re-leaked into the logs on every restart. A
	// re-mint (the operator forgot to persist DATA_DIR) is visible because the
	// "minted" banner prints again.
	const banner = `apps/self-host (Bun) listening on ${origin} (rooms in ${dataDir})`;
	if (!instance) {
		console.log(
			`${banner}\nNo OAuth providers configured -> solo mode (dev resolver injected)`,
		);
	} else if (instance.minted) {
		console.log(
			`${banner}\nNo OAuth providers configured -> solo mode.\n` +
				`Instance token (paste into the client instance setting):\n  ${instance.token}\n` +
				`Saved 0600 to ${instance.path}`,
		);
	} else {
		console.log(
			`${banner}\nNo OAuth providers configured -> solo mode. Instance token loaded from ${instance.path} (view: cat ${instance.path})`,
		);
	}
}

// Run production only when this file is the entrypoint. `server.dev.ts` imports
// `startSelfHostServer` to boot the dev variant, and must not trigger a second
// listener here.
if (import.meta.main) startSelfHostServer();
