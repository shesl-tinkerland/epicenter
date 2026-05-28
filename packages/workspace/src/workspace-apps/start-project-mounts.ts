/**
 * Project-mount startup.
 *
 * `startProjectMounts()` is the daemon entry point: validate the mounts from
 * `epicenter.config.ts`, run every `open(ctx)` in parallel, and either return
 * the started mounts or dispose the successfully opened ones if any sibling
 * failed.
 *
 * The host owns auth lifecycle. It refuses to start when machine auth is
 * signed-out, then builds a per-mount `MountContext` carrying the lazy
 * `keyring` reader (with a sign-out guard) plus the auth-derived function
 * refs (`openWebSocket`, `onReconnectSignal`) the mount forwards into
 * `openCollaboration`.
 */

import { resolve } from 'node:path';
import type { OwnerId } from '@epicenter/constants/identity';
import type { Keyring } from '@epicenter/encryption';
import { Err, Ok, type Result } from 'wellcrafted/result';

import type { Mount, MountContext } from '../daemon/define-mount.js';
import { validateMountNames } from '../daemon/mount-validation.js';
import type { StartedMount } from '../daemon/types.js';
import { asDeviceId } from '../document/device-id.js';
import { hashYDocClientId } from '../shared/client-id.js';
import type { ProjectDir } from '../shared/types.js';
import type { WorkspaceAuthClient } from './auth-client.js';
import { WorkspaceAppError } from './errors.js';

export type StartProjectMountsOptions = {
	projectDir: ProjectDir | string;
	auth: WorkspaceAuthClient;
	mounts: readonly Mount[];
};

/**
 * Bring every configured mount online.
 *
 * Opens run in parallel because each mount owns its own resources. If any open
 * fails, every successfully opened runtime is disposed before returning the
 * first failure as a structured error.
 */
export async function startProjectMounts(
	options: StartProjectMountsOptions,
): Promise<Result<StartedMount[], WorkspaceAppError>> {
	const { auth, mounts } = options;
	const projectDir = resolve(options.projectDir) as ProjectDir;
	if (auth.state.status === 'signed-out') {
		return WorkspaceAppError.WorkspaceAuthSignedOut();
	}

	const issue = validateMountNames(mounts.map((mount) => mount.name));
	if (issue !== null) {
		return WorkspaceAppError.MountRejected(issue);
	}

	// Sign-out is guarded above, so `auth.state.ownerId` is stable here. Pin it
	// to each mount's context so mounts build URLs without re-reading auth
	// state.
	const ownerId = auth.state.ownerId;

	const settled = await Promise.allSettled(
		mounts.map((mount) => openOneMount({ mount, projectDir, auth, ownerId })),
	);

	const opened: StartedMount[] = [];
	let firstError: WorkspaceAppError | null = null;

	for (const result of settled) {
		if (result.status !== 'fulfilled') {
			if (firstError === null) {
				firstError = WorkspaceAppError.MountOpenFailed({
					mount: '<unknown>',
					cause: result.reason,
				}).error;
			}
			continue;
		}
		const value = result.value;
		if (value.error) {
			if (firstError === null) firstError = value.error;
			continue;
		}
		opened.push(value.data);
	}

	if (firstError !== null) {
		await disposeOpenedRuntimes(opened);
		return Err(firstError);
	}

	return Ok(opened);
}

async function openOneMount({
	mount,
	projectDir,
	auth,
	ownerId,
}: {
	mount: Mount;
	projectDir: ProjectDir;
	auth: WorkspaceAuthClient;
	ownerId: OwnerId;
}): Promise<Result<StartedMount, WorkspaceAppError>> {
	const ctx = {
		projectDir,
		mount: mount.name,
		yDocClientId: hashYDocClientId(projectDir),
		deviceId: asDeviceId(`${mount.name}-daemon`),
		ownerId,
		keyring: createMountKeyringReader({ auth, mount: mount.name }),
		// `auth.openWebSocket` / `auth.onStateChange` are closure-based on the
		// auth client and do not read `this`, so passing the method reference
		// directly is safe (no `.bind(auth)` needed).
		openWebSocket: auth.openWebSocket,
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

async function disposeOpenedRuntimes(
	runtimes: readonly StartedMount[],
): Promise<void> {
	await Promise.allSettled(
		runtimes.map((entry) =>
			Promise.resolve(entry.runtime[Symbol.asyncDispose]()),
		),
	);
}
