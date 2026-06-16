/**
 * Library types shared by sub-app factories and middleware.
 *
 * Per-request state lives on the Hono context (`c.var.user`, `c.var.db`,
 * etc.). The `requireOwnership` middleware resolves the owner partition
 * from `(mode, c.var.user.id)`, rejects URL `:ownerId` mismatches at
 * the boundary, and stashes the result on `c.var.ownerId`.
 */

import type { AuthUser, UserId } from '@epicenter/auth';
import type { OwnerId } from '@epicenter/identity';
import type { ActionManifest } from '@epicenter/workspace';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { createAuth } from './auth/create-auth.js';
import type * as schema from './db/schema/index.js';
import type { Rooms } from './room/contracts.js';

/**
 * Per-connection identity and runtime state, stamped onto the Cloudflare
 * Durable Object WebSocket attachment so presence survives hibernation.
 *
 * `nodeId` identifies one Epicenter app on one persistent storage scope
 * (browser tab, Tauri window, extension service worker, CLI process; tabs
 * sharing localStorage share an id). The client generates and persists its
 * own; lifespan is the client's concern.
 *
 * `connectedAt` is stamped at upgrade time and surfaced in presence frames so
 * receivers can render an "online since" affordance and tie-break multi-tab
 * same-node (newest wins).
 *
 * `actions` is the published action manifest for this socket. Starts as `{}`
 * at upgrade; updated to the node's manifest when `presence_publish` arrives.
 * Relay treats the value as opaque (it forwards JSON to peers, never inspects).
 *
 * In personal mode every connection to a given DO shares the same `userId`
 * (the DO name partitions by user). In shared mode connections can carry
 * different `userId` values because admitted users share the DO. The DO never
 * branches on which mode it is in.
 */
export type Connection = {
	userId: UserId;
	nodeId: string;
	connectedAt: number;
	actions: ActionManifest;
};

/**
 * Hono context type for every library sub-app.
 *
 * `Bindings` is `Cloudflare.Env`, declared by each deployment with the
 * exact set of bindings it provides. The library declares the bindings it
 * reads in the exported `ServerBindings` interface (see
 * server-bindings.ts); cloud-only bindings such as `AUTUMN_SECRET_KEY` are
 * declared in apps/api's generated types and never appear there.
 *
 * `Variables` are populated by request-scoped middleware: database client,
 * auth instance, resolved user, after-response queue, and the runtime-
 * specific rooms registry. The library does NOT carry `planId`; that is a
 * cloud-only variable owned by apps/api's billing middleware.
 */
export type Env = {
	Bindings: Cloudflare.Env;
	Variables: {
		db: NodePgDatabase<typeof schema>;
		auth: ReturnType<typeof createAuth>;
		authBaseURL: string;
		/**
		 * Origins this deployment trusts for CORS, cookie-mutation CSRF, and
		 * Better Auth's redirect allow-list. Supplied by the deployment
		 * (`createServerApp`'s `resolveTrustedOrigins`), never hardcoded in the
		 * library: a self-host trusts its own origins, not Epicenter cloud's.
		 */
		trustedOrigins: string[];
		user: AuthUser;
		/**
		 * Resolved owner partition for this request. Populated by the
		 * `requireOwnership` middleware after auth runs. In personal mode
		 * equals the authenticated user's id; in shared mode equals
		 * `SHARED_OWNER_ID`. Handlers read this instead of branching on
		 * mode or re-deriving from the URL `:ownerId` param.
		 */
		ownerId: OwnerId;
		/**
		 * Per-request collection of fire-and-forget promises that must
		 * outlive the HTTP response. Handlers push promises (typically DB
		 * writes that use `c.var.db`); the server-app's lifecycle middleware
		 * passes the whole array to `Promise.allSettled(...).then(close pg)`
		 * inside `executionCtx.waitUntil`, so the worker isolate stays
		 * alive AND the pg client outlives every queued write.
		 */
		afterResponse: Promise<unknown>[];
		rooms: Rooms;
	};
};
