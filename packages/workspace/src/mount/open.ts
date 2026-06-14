/**
 * Open a project: the daemon entry point from one `epicenter.config.ts` to one
 * live mount runtime.
 *
 * `openProject()` opens the single mount a config declares:
 *
 *   1. `loadProjectConfig(epicenterRoot)` imports `epicenter.config.ts` and
 *      validates that its default export is a single `Mount` (name format
 *      included).
 *   2. Refuse to start when machine auth is signed out.
 *   3. Refuse to adopt a hand-populated mount folder before the namespace
 *      exists, then claim the Epicenter folder's generated-state boundary.
 *   4. Build the `MountContext` and run `open(ctx)`, returning the started mount
 *      or a structured error.
 *
 * One `epicenter.config.ts` is one mount, so there is no sibling to open in
 * parallel or to dispose on partial failure: that composition belongs to the
 * vault layer, which opens many of these. The host owns auth lifecycle. The
 * `MountContext` carries the lazy `keyring` reader (with a sign-out guard) plus
 * the auth-derived function refs (`openWebSocket`, `onReconnectSignal`) the
 * mount forwards into `openCollaboration`. Config-discovery errors and startup
 * errors flow back as one `Result` union.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type { Keyring } from '@epicenter/encryption';
import type { OwnerId } from '@epicenter/identity';
import { Err, Ok, type Result, trySync } from 'wellcrafted/result';

import { asDeviceId } from '../document/device-id.js';
import { mountMarkdownPath } from '../document/workspace-paths.js';
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
 * Bring one app online: import its config, guard and claim its folder, then
 * open its one mount. Returns the started mount or a config/startup error.
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

	// The mount name was format-validated at load time (`loadProjectConfig`).
	// Refuse to adopt a mount folder the user populated before the namespace
	// exists, then claim the folder before any generated state is written.
	const populated = findPopulatedMountFolder(epicenterRoot, mount);
	if (populated !== null) {
		return WorkspaceAppError.MountFolderNotEmpty(populated);
	}

	const claimResult = trySync({
		try: () => claimEpicenterFolder(epicenterRoot),
		catch: (cause) =>
			WorkspaceAppError.EpicenterFolderClaimFailed({ epicenterRoot, cause }),
	});
	if (claimResult.error !== null) return Err(claimResult.error);

	// Sign-out is guarded above, so `auth.state.ownerId` is stable here. Pin it
	// to the mount's context so the mount builds URLs without re-reading auth
	// state.
	const ownerId = auth.state.ownerId;

	return openOneMount({ mount, epicenterRoot, auth, ownerId });
}

const IGNORED_BOOTSTRAP_ENTRIES = new Set(['.DS_Store', 'Thumbs.db']);

const ROOT_GITIGNORE = `# Epicenter folder. Only epicenter.config.ts is tracked; the generated mount
# projections and the machine state under .epicenter/ are derived from the Yjs
# log and rebuilt on demand, so git ignores them.
/*
!/.gitignore
!/epicenter.config.ts
`;

/**
 * Bootstrap guard: refuse to claim a mount folder a user populated before the
 * namespace exists.
 *
 * `.epicenter/` is Epicenter's "this folder is mine" marker. Until it exists,
 * the namespace has not been established, so a non-empty `<root>/<mount>/` (the
 * direct child named after the declared mount) is the user's own data, not a
 * generated projection. Adopting it would let `markdown_rebuild` later sweep
 * those files. Once `.epicenter/` exists, the declared mount folder is reserved
 * for Epicenter to generate and rebuild, so this guard stands down.
 *
 * OS bookkeeping files (`.DS_Store`, `Thumbs.db`) do not count as content: a
 * folder a user merely browsed in Finder is not "populated by hand."
 *
 * Returns the offending mount, or null when bootstrap is safe.
 */
function findPopulatedMountFolder(
	epicenterRoot: EpicenterRoot,
	mount: Mount,
): { mount: string; path: string } | null {
	const namespaceEstablished = existsSync(join(epicenterRoot, '.epicenter'));
	if (namespaceEstablished) return null;

	const path = mountMarkdownPath(epicenterRoot, mount.name);
	if (!existsSync(path)) return null;
	const isPopulated =
		!statSync(path).isDirectory() ||
		readdirSync(path).some((entry) => !IGNORED_BOOTSTRAP_ENTRIES.has(entry));
	return isPopulated ? { mount: mount.name, path } : null;
}

/**
 * Claim the folder before any mount can create generated state.
 *
 * Fresh namespaces get the root ignore first, then `.epicenter/`. That ordering
 * keeps `.epicenter/` a trustworthy "already claimed" marker: once it exists,
 * either the root ignore already exists or the user had their own ignore file
 * that Epicenter must not overwrite.
 */
function claimEpicenterFolder(epicenterRoot: EpicenterRoot): void {
	const namespaceEstablished = existsSync(join(epicenterRoot, '.epicenter'));
	if (!namespaceEstablished) {
		const rootGitignorePath = join(epicenterRoot, '.gitignore');
		if (!existsSync(rootGitignorePath)) {
			writeFileSync(rootGitignorePath, ROOT_GITIGNORE);
		}
	}

	const projectDataDir = join(epicenterRoot, '.epicenter');
	mkdirSync(projectDataDir, { recursive: true, mode: 0o700 });
	const cacheGitignorePath = join(projectDataDir, '.gitignore');
	if (!existsSync(cacheGitignorePath)) {
		writeFileSync(cacheGitignorePath, '*\n', { mode: 0o600 });
	}
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
