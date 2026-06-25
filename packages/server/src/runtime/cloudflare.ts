/**
 * The Cloudflare runtime adapter: the three runtime-port concerns (ADR-0059)
 * wired to Workers bindings, as one {@link RuntimeAdapter} a Workers deployment
 * passes to `createServerApp`. The wiring (a per-request pg client over
 * Hyperdrive, `waitUntil`, and the Durable Object room registry) is identical
 * across both Cloudflare deployables, so it lives here once.
 *
 * The deployment supplies its OWN two binding handles through the `hyperdrive`
 * and `room` extractors. That keeps the binding NAMES (`HYPERDRIVE`, `ROOM`,
 * which each app chooses in its own `wrangler.jsonc`) and the `Cloudflare.Env`
 * cast at the app edge, where naming Cloudflare is honest and the access is
 * type-checked against the deployment's generated bindings (ADR-0059). This
 * library file names no binding name and casts no env; it only knows the
 * binding TYPES, through what `connectHyperdriveDb` and
 * `createDurableObjectRooms` already accept. A Bun host builds its own adapter
 * inline over a `pg.Pool`, a no-op, and an in-process room registry.
 */

import { connectHyperdriveDb } from '../db/backends/cloudflare.js';
import { createDurableObjectRooms } from '../room/backends/cloudflare/registry.js';
import type { RuntimeAdapter } from '../server-app.js';
import type { ServerBindings } from '../server-bindings.js';

/**
 * Build the Cloudflare {@link RuntimeAdapter} for `createServerApp`. The
 * deployment passes one extractor per binding, reading it off its own
 * `Cloudflare.Env`; per-room DO sharding stays the cloud's binding of the room
 * actor (ADR-0059): hibernate-to-zero and single-writer-per-room at
 * multi-tenant scale.
 */
export function cloudflare(bindings: {
	/** Read this deployment's Hyperdrive binding off its env (`env.HYPERDRIVE`). */
	hyperdrive: (
		env: ServerBindings,
	) => Parameters<typeof connectHyperdriveDb>[0];
	/** Read this deployment's Durable Object room namespace off its env (`env.ROOM`). */
	room: (env: ServerBindings) => Parameters<typeof createDurableObjectRooms>[0];
}): RuntimeAdapter {
	return {
		connectDb: (env) => connectHyperdriveDb(bindings.hyperdrive(env)),
		afterResponse: (c, work) => c.executionCtx.waitUntil(work),
		resolveRooms: (env) => createDurableObjectRooms(bindings.room(env)),
	};
}
