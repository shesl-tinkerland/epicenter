/**
 * Shared project-root option for commands that address a local daemon.
 *
 * By default commands discover the nearest Epicenter project from the
 * current working directory. `-C <dir>` changes the discovery start point.
 */

import { resolve } from 'node:path';

import { findEpicenterDir } from '@epicenter/workspace/node';

export function resolveProjectDir(start: string): string {
	try {
		return findEpicenterDir(start);
	} catch {
		return resolve(start);
	}
}

export function resolveProjectArg(project: string | undefined): string {
	return resolveProjectDir(project ?? process.cwd());
}

export const projectArg = {
	type: 'string',
	alias: 'C',
	description: 'Start directory for Epicenter project discovery',
	valueHint: 'dir',
} as const;
