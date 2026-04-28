/**
 * Shared yargs option specs + argv readers for the flags every command
 * uses. `--dir` / `-C` mirrors `git -C`, `cargo --manifest-path`,
 * `pnpm --dir`, `bun --cwd`. `--workspace` / `-w` disambiguates when
 * `epicenter.config.ts` exports more than one opened handle.
 *
 * {@link resolveTarget} is the canonical way to consume both flags at
 * once. Every daemon-dispatching command (`list`, `run`, `peers`)
 * builds it at the top of its handler; the result feeds `getDaemon`,
 * which resolves the typed daemon client or surfaces `MissingConfig` /
 * `Required` for the renderer.
 */

import { resolve } from 'node:path';

import type { Options } from 'yargs';

export const dirOption: Options = {
	type: 'string',
	alias: 'C',
	default: '.',
	description:
		'Directory containing epicenter.config.ts (default: cwd). Mirrors `git -C`.',
};

export function dirFromArgv(argv: Record<string, unknown>): string {
	return typeof argv.dir === 'string' ? argv.dir : '.';
}

export const workspaceOption: Options = {
	type: 'string',
	alias: 'w',
	description:
		'Config entry name (required when epicenter.config.ts exports multiple workspaces)',
};

export function workspaceFromArgv(
	argv: Record<string, unknown>,
): string | undefined {
	return typeof argv.workspace === 'string' ? argv.workspace : undefined;
}

/**
 * Resolved `--dir` + `--workspace` for a single command invocation. One
 * source of truth: every handler builds this once at the top, then
 * passes it to `getDaemon`.
 */
export type ResolvedTarget = {
	absDir: string;
	userWorkspace: string | undefined;
};

export function resolveTarget(args: Record<string, unknown>): ResolvedTarget {
	return {
		absDir: resolve(dirFromArgv(args)),
		userWorkspace: workspaceFromArgv(args),
	};
}
