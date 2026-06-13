/**
 * Open a project: the single daemon entry point from `epicenter.config.ts` to
 * live mount runtimes.
 *
 * `openProject()` is what `epicenter daemon up` calls. It owns the whole
 * startup path:
 *
 *   1. `loadProjectConfig(epicenterRoot)` imports `epicenter.config.ts` and
 *      validates that its default export is a single `Mount`.
 *   2. Refuse to start when machine auth is signed out. (The mount name was
 *      already format-validated at load time, in `loadProjectConfig`.)
 *   3. Build the `MountContext` and run `open(ctx)`, returning the started
 *      mount or a structured error.
 *
 * The host owns auth lifecycle. Each `MountContext` carries the lazy `keyring`
 * reader (with a sign-out guard) plus the auth-derived function refs
 * (`openWebSocket`, `onReconnectSignal`) the mount forwards into
 * `openCollaboration`. Config-discovery errors and startup errors flow back as
 * one `Result` union.
 */

import { resolve } from 'node:path';
import type { Keyring } from '@epicenter/encryption';
import type { OwnerId } from '@epicenter/identity';
import { Err, Ok, type Result } from 'wellcrafted/result';

import { asDeviceId } from '../document/device-id.js';
import { hashYDocClientId } from '../shared/client-id.js';
import type { EpicenterRoot } from '../shared/types.js';
import type { WorkspaceAuthClient } from './auth-client.js';
import type { Mount, MountContext, StartedMount } from './contract.js';
import { loadProjectConfig, type ProjectConfigError } from './load-config.js';
import { WorkspaceAppError } from './open-errors.js';

export type OpenProjectOptions = {
	epicenterRoot: EpicenterRoot | string;
	auth: WorkspaceAuthClient;
};

/**
 * Bring a project's daemon online: import its config, then open the one mount
 * it declares. Returns the started mount or a config/startup error.
 *
 * One `epicenter.config.ts` is one mount, so there is no sibling to open in
 * parallel or to dispose on partial failure: if the mount's `open(ctx)` throws,
 * the error is the whole result. The daemon serves a set of started mounts and
 * routes IPC by name; today that set is this one mount (the host assembles it
 * in `runUp`).
 */
export async function openProject(
	options: OpenProjectOptions,
): Promise<Result<StartedMount, ProjectConfigError | WorkspaceAppError>> {
	const { auth } = options;
	const epicenterRoot = resolve(options.epicenterRoot) as EpicenterRoot;

	const { data: mount, error: configError } =
		await loadProjectConfig(epicenterRoot);
	if (configError !== null) return Err(configError);

	if (auth.state.status === 'signed-out') {
		return WorkspaceAppError.WorkspaceAuthSignedOut();
	}

	// The mount name was format-validated at load time (`loadProjectConfig`), so
	// it is well-formed here. Sign-out is guarded above, so `auth.state.ownerId`
	// is stable: pin it to the mount's context so the mount builds URLs without
	// re-reading auth state.
	const ownerId = auth.state.ownerId;

	return openOneMount({ mount, epicenterRoot, auth, ownerId });
}

async function openOneMount({
	mount,
	epicenterRoot,
	auth,
	ownerId,
}: {
	mount: Mount;
	epicenterRoot: EpicenterRoot;
	auth: WorkspaceAuthClient;
	ownerId: OwnerId;
}): Promise<Result<StartedMount, WorkspaceAppError>> {
	const ctx = {
		epicenterRoot,
		mount: mount.name,
		yDocClientId: hashYDocClientId(epicenterRoot),
		deviceId: asDeviceId(`${mount.name}-daemon`),
		ownerId,
		keyring: createMountKeyringReader({ auth, mount: mount.name }),
		// `auth.openWebSocket` / `auth.fetch` / `auth.onStateChange` are
		// closure-based on the auth client and do not read `this`, so passing the
		// method reference directly is safe (no `.bind(auth)` needed).
		openWebSocket: auth.openWebSocket,
		fetch: auth.fetch,
		onReconnectSignal: auth.onStateChange,
	} satisfies MountContext;
	try {
		const runtime = await mount.open(ctx);
		return Ok({ mount: mount.name, runtime });
	} catch (cause) {
		return WorkspaceAppError.MountOpenFailed({
			mount: mount.name,
			cause,
		});
	}
}

/**
 * Build the lazy keyring reader the mount ctx hands to factories. Reads
 * `auth.state` on every call so a late sign-out throws at the next encrypted
 * write or registration site instead of the host having to re-check on every
 * open.
 */
function createMountKeyringReader({
	auth,
	mount,
}: {
	auth: WorkspaceAuthClient;
	mount: string;
}): () => Keyring {
	return () => {
		if (auth.state.status === 'signed-out') {
			throw new Error(`[${mount}-daemon] auth signed-out.`);
		}
		return auth.state.keyring;
	};
}
