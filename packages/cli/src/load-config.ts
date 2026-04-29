/**
 * Workspace config loader.
 *
 * Contract:
 *
 *   A named export becomes a workspace if it implements [Symbol.dispose]
 *   (called at exit; the discriminator). If it also has:
 *
 *     whenReady: Promise         awaited before action invocations
 *     actions:   Actions          exposed to `run` and `list`
 *     sync:      SyncAttachment   enables --peer + `peers`
 *
 *   …the CLI uses them. Anything else is the factory's business.
 *
 * The recommended config style is to export the result of an `openFoo()`
 * factory directly (the same factory the app uses elsewhere), and let
 * the factory's return shape be the contract.
 *
 * @example
 * ```ts
 * // epicenter.config.ts
 * import { openFuji } from '@my/app/server';
 * export const fuji = openFuji({ auth, device });
 * ```
 *
 * Then on the consumer side:
 *
 * ```ts
 * await using config = await loadConfig('/path/to/project');
 * for (const { name, workspace } of config.entries) {
 *   if (workspace.whenReady) await workspace.whenReady;
 *   // dispatch actions, read sync, ...
 * }
 * // sockets flushed automatically on scope exit
 * ```
 */

import type {
	LoadedWorkspace,
	PeerAwarenessState,
	WorkspaceEntry,
} from '@epicenter/workspace';
import { join, resolve } from 'node:path';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result, tryAsync } from 'wellcrafted/result';

export const CONFIG_FILENAME = 'epicenter.config.ts';

export type { LoadedWorkspace, WorkspaceEntry };

/**
 * Per-peer awareness state under the standard `device` schema. Re-exported
 * from `@epicenter/workspace` for ergonomic consumption; `state.device` is
 * set synchronously at attach time, so consumers read
 * `state.device.{id,name,platform}` without `?.`.
 */
export type AwarenessState = PeerAwarenessState;

export type LoadConfigResult = {
	entries: WorkspaceEntry[];
	/**
	 * Release every workspace. Calls each `workspace[Symbol.dispose]()`
	 * (synchronous) and awaits any `sync.whenDisposed` barriers so the CLI
	 * exits cleanly after closing sockets.
	 *
	 * Implements `[Symbol.asyncDispose]` so callers can write
	 * `await using config = await loadConfig(...)` per TC39 explicit
	 * resource management.
	 */
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * A workspace is anything with `[Symbol.dispose]`. That's the whole
 * contract; the factory's return shape is the source of truth for
 * everything else.
 */
function isLoadedWorkspace(value: unknown): value is LoadedWorkspace {
	return (
		value != null &&
		typeof value === 'object' &&
		typeof (value as Record<PropertyKey, unknown>)[Symbol.dispose] ===
			'function'
	);
}

/**
 * Tagged-error variants returned by {@link loadConfig}. All three are
 * user-facing (file missing, config crashed at module load, no workspace
 * exports), not panics: callers render them and exit 1.
 *
 * - `MissingFile`: no `epicenter.config.ts` at the resolved path.
 * - `ImportFailed`: the dynamic `import()` rejected. Typically a syntax
 *   error or a top-level throw from a workspace factory (e.g. invalid
 *   creds at construction time).
 * - `EmptyConfig`: the file loaded but exposed no workspace exports.
 */
export const LoadError = defineErrors({
	MissingFile: ({ configPath }: { configPath: string }) => ({
		message: `No ${CONFIG_FILENAME} found in ${configPath}`,
		configPath,
	}),
	ImportFailed: ({
		configPath,
		cause,
	}: {
		configPath: string;
		cause: unknown;
	}) => ({
		message: `failed to load ${configPath}: ${extractErrorMessage(cause)}`,
		configPath,
		cause,
	}),
	EmptyConfig: ({ configPath }: { configPath: string }) => ({
		message:
			`No workspaces found in ${configPath}.\n` +
			`Export at least one named value implementing [Symbol.dispose], ` +
			`typically the return of an openFoo() factory.`,
		configPath,
	}),
});
export type LoadError = InferErrors<typeof LoadError>;

/**
 * Load workspace exports from an `epicenter.config.ts` file. Default
 * exports are skipped; use named exports so the CLI can address them by
 * name.
 */
export async function loadConfig(
	targetDir: string,
): Promise<Result<LoadConfigResult, LoadError>> {
	const configPath = join(resolve(targetDir), CONFIG_FILENAME);

	if (!(await Bun.file(configPath).exists())) {
		return LoadError.MissingFile({ configPath });
	}

	const importResult = await tryAsync({
		try: () => import(Bun.pathToFileURL(configPath).href),
		catch: (cause) => LoadError.ImportFailed({ configPath, cause }),
	});
	if (importResult.error) return importResult;
	const module = importResult.data;

	const entries: WorkspaceEntry[] = [];
	for (const [name, value] of Object.entries(module)) {
		if (name === 'default') continue;
		if (!isLoadedWorkspace(value)) continue;
		entries.push({ name, workspace: value });
	}

	if (entries.length === 0) {
		return LoadError.EmptyConfig({ configPath });
	}

	return Ok({
		entries,
		async [Symbol.asyncDispose]() {
			const barriers: Promise<unknown>[] = [];
			for (const { workspace } of entries) {
				if (workspace.sync?.whenDisposed) barriers.push(workspace.sync.whenDisposed);
				workspace[Symbol.dispose]();
			}
			await Promise.all(barriers);
		},
	});
}
