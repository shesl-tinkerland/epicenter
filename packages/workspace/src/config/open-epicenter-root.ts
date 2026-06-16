/**
 * Open an Epicenter root: the single daemon entry point from
 * `epicenter.config.ts` to the live mount runtime.
 *
 * `openEpicenterRoot()` is what `epicenter daemon up` calls. It owns the whole
 * startup path:
 *
 *   1. `loadEpicenterConfig(epicenterRoot)` imports `epicenter.config.ts` and
 *      validates that its default export is a single `Mount` with a valid name.
 *   2. Claim the Epicenter folder's generated-state boundary and resolve its
 *      durable per-install node id (persisted under `.epicenter/`).
 *   3. Build the `MountSession` from the caller's auth client (or `null` when
 *      signed out: a logged-out daemon is a valid state), then open the mount
 *      with it.
 *
 * One folder declares one mount. The daemon never gates on auth: it receives an
 * auth client (or `null`) from the CLI, hands the mount the resulting
 * `session`, and lets the mount decide. A local mirror ignores it, while a
 * peer-plane mount uses its socket or returns `inactive("sign in ...")`. The
 * mount either becomes `started` or is reported `inactive`. Only a config error,
 * a folder-claim failure, or a thrown `open` aborts startup.
 *
 * The structural `WorkspaceAuthClient` and the two startup-error variants live
 * here, beside their only caller, the same way `load-epicenter-config.ts` keeps
 * `EpicenterConfigError` next to the loader that raises it.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { AuthState } from '@epicenter/identity';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync, trySync } from 'wellcrafted/result';

import { isInactive, type MountSession } from '../daemon/define-mount.js';
import type { StartedMount } from '../daemon/types.js';
import type { AuthedFetch, EpicenterRoot } from '../shared/types.js';
import { resolveDaemonNodeId } from './daemon-node-id.js';
import {
	type EpicenterConfigError,
	loadEpicenterConfig,
} from './load-epicenter-config.js';

/**
 * Workspace's structural view of an auth client. Any object whose shape
 * matches (notably `@epicenter/auth`'s `AuthClient`) can be passed to
 * `openEpicenterRoot`.
 *
 * Workspace reads four surfaces: the discriminated `state` (to gate startup on
 * signed-in), `openWebSocket` (for collaboration sockets with the bearer
 * subprotocol attached), `fetch` (the authed `fetch` for one-shot HTTP to the
 * relay), and `onStateChange` (for the reconnect signal). The narrow contract
 * is what lets this package compile without depending on `@epicenter/auth`.
 */
export type WorkspaceAuthClient = {
	state: AuthState;
	openWebSocket(url: string | URL, protocols?: string[]): Promise<WebSocket>;
	fetch: AuthedFetch;
	onStateChange(fn: (state: AuthState) => void): () => void;
};

/**
 * Structured errors for mount startup.
 *
 * The namespace claim surfaces `EpicenterFolderClaimFailed` before the mount
 * opens. Startup wraps any throw from the mount's `open(ctx)` in
 * `MountOpenFailed`.
 *
 * Mount-name format is validated upstream by `loadEpicenterConfig`, which
 * surfaces a bad name as an `EpicenterConfigInvalid` pointed at the file.
 *
 * A mount that returns `inactive(reason)` is not an error: it is reported as an
 * inactive mount, not raised here.
 */
export const WorkspaceAppError = defineErrors({
	EpicenterFolderClaimFailed: ({
		epicenterRoot,
		cause,
	}: {
		epicenterRoot: string;
		cause: unknown;
	}) => ({
		message: `Failed to claim Epicenter folder "${epicenterRoot}": ${extractErrorMessage(cause)}`,
		epicenterRoot,
		cause,
	}),
	MountOpenFailed: ({ mount, cause }: { mount: string; cause: unknown }) => ({
		message: `Mount "${mount}" failed to open: ${extractErrorMessage(cause)}`,
		mount,
		cause,
	}),
});

export type WorkspaceAppError = InferErrors<typeof WorkspaceAppError>;

/** The mount declined to start, with the reason it returned. */
export type InactiveMount = {
	mount: string;
	reason: string;
};

/** The outcome of opening a root: the mount either started or declined. */
export type OpenedMount =
	| { status: 'started'; entry: StartedMount }
	| { status: 'inactive'; entry: InactiveMount };

export type OpenEpicenterRootOptions = {
	epicenterRoot: EpicenterRoot | string;
	/**
	 * The machine auth client, or `null` when signed out (a valid, supported
	 * state). The CLI owns loading it and mapping "no saved session" to `null`;
	 * the daemon only reads its state to build the mount's `session`.
	 */
	auth: WorkspaceAuthClient | null;
};

/**
 * Bring an Epicenter root's daemon online: import its config, claim the folder,
 * then open the one mount it declares. Returns whether the mount started or
 * declined, or the config/startup error.
 */
export async function openEpicenterRoot(
	options: OpenEpicenterRootOptions,
): Promise<Result<OpenedMount, EpicenterConfigError | WorkspaceAppError>> {
	const epicenterRoot = resolve(options.epicenterRoot) as EpicenterRoot;

	const { data: mount, error: configError } =
		await loadEpicenterConfig(epicenterRoot);
	if (configError !== null) return Err(configError);

	// Claim the folder's machine state and resolve its durable node identity in
	// one step: both write under `.epicenter/`, and a node id is just more
	// machine state living there. The id is generated once and persisted, so it
	// is stable across restarts, distinct per folder, and never derived from the
	// path or the mount name (either of which would collide across machines).
	const claimResult = trySync({
		try: () => {
			claimEpicenterFolder(epicenterRoot);
			return resolveDaemonNodeId(epicenterRoot);
		},
		catch: (cause) =>
			WorkspaceAppError.EpicenterFolderClaimFailed({ epicenterRoot, cause }),
	});
	if (claimResult.error !== null) return Err(claimResult.error);
	const nodeId = claimResult.data;

	// The session carries only auth-derived capabilities; the node identity is
	// auth-independent (a signed-out daemon still has one), so it rides on the
	// context beside `epicenterRoot` and `mount`.
	const session = buildMountSession(options.auth);

	const ctx = { epicenterRoot, mount: mount.name, nodeId, session };
	const { data: result, error: openError } = await tryAsync({
		try: () => Promise.resolve(mount.open(ctx)),
		catch: (cause) =>
			WorkspaceAppError.MountOpenFailed({ mount: mount.name, cause }),
	});
	if (openError !== null) return Err(openError);

	if (isInactive(result)) {
		return Ok({
			status: 'inactive',
			entry: { mount: mount.name, reason: result.reason },
		});
	}
	return Ok({
		status: 'started',
		entry: { mount: mount.name, runtime: result },
	});
}

/**
 * Build the signed-in capability kit, or `null` when machine auth is absent or
 * signed out.
 */
function buildMountSession(
	auth: WorkspaceAuthClient | null,
): MountSession | null {
	if (auth === null || auth.state.status === 'signed-out') return null;
	return {
		ownerId: auth.state.ownerId,
		// `auth.openWebSocket` / `auth.fetch` / `auth.onStateChange` are
		// closure-based on the auth client and do not read `this`, so passing the
		// method reference directly is safe (no `.bind(auth)` needed).
		openWebSocket: auth.openWebSocket,
		onReconnectSignal: auth.onStateChange,
		fetch: auth.fetch,
	};
}

/**
 * Claim the folder before any mount can create generated state.
 *
 * `.epicenter/` is the machine-state marker for an app folder. Generated
 * markdown directories claim themselves with their own `.gitignore` files, so
 * this startup step only owns hidden machine state.
 */
function claimEpicenterFolder(epicenterRoot: EpicenterRoot): void {
	const epicenterDataDir = join(epicenterRoot, '.epicenter');
	mkdirSync(epicenterDataDir, { recursive: true, mode: 0o700 });
	const cacheGitignorePath = join(epicenterDataDir, '.gitignore');
	if (!existsSync(cacheGitignorePath)) {
		writeFileSync(cacheGitignorePath, '*\n', { mode: 0o600 });
	}
}
