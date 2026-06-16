/**
 * Ambient shim for the library's own TS program only: applies the
 * `ServerBindings` contract to `Cloudflare.Env` so library code can read
 * `c.env` without a deployment present.
 *
 * Deliberately never imported. Each deployment's program resolves
 * `Cloudflare.Env` from exactly one source of its own (apps/api via
 * `wrangler types`, apps/self-host via its hand-written
 * worker-configuration.d.ts) and proves it against `ServerBindings`
 * itself. Importing this shim from a module would leak the augmentation
 * into deployment programs and merge with their declarations.
 */

import type { ServerBindings } from './server-bindings.js';

declare global {
	namespace Cloudflare {
		interface Env extends ServerBindings {}
	}
}
