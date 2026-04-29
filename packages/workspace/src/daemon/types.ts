/**
 * Daemon-side types describing the shape of a hosted workspace.
 *
 * `LoadedWorkspace` is the structural contract every workspace export has
 * to satisfy: the `[Symbol.dispose]` discriminator, plus the optional
 * `whenReady`, `actions`, and `sync` fields the daemon reads when present.
 *
 * `WorkspaceEntry` is one named entry the daemon hosts. The CLI's config
 * loader produces these from `epicenter.config.ts` exports.
 */

import type { Actions } from '../shared/actions.js';
import type { SyncAttachment } from '../document/attach-sync.js';

/**
 * Fields the daemon looks at on each workspace export. Only `[Symbol.dispose]`
 * is required (it's the discriminator); everything else is read when
 * present. Extra fields the factory returns are ignored.
 */
export type LoadedWorkspace = {
	/**
	 * Called by the daemon at exit. The discriminator: its presence is what
	 * marks the export as a workspace.
	 */
	[Symbol.dispose](): void;

	/** Awaited before any action invocation, if present. */
	readonly whenReady?: Promise<unknown>;

	/** Exposes runnable actions to `epicenter run` / `epicenter list`. */
	readonly actions?: Actions;

	/**
	 * Enables `--peer` targeting and `epicenter peers`. `attachSync(doc, { device })`
	 * carries presence inline; `peers()` / `find()` / `observe()` live on the
	 * SyncAttachment when the workspace was constructed with a `device`.
	 */
	readonly sync?: SyncAttachment;
};

/** One named workspace export from `epicenter.config.ts`. */
export type WorkspaceEntry = {
	name: string;
	workspace: LoadedWorkspace;
};
