import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PROJECT_CONFIG_FILENAME } from '../mount/config-source.js';
import type { EpicenterRoot } from '../shared/types.js';

export function findEpicenterRoot(
	start: string = process.cwd(),
): EpicenterRoot {
	let current = resolve(start);
	while (true) {
		if (existsSync(join(current, PROJECT_CONFIG_FILENAME))) {
			return current as EpicenterRoot;
		}

		const parent = dirname(current);
		if (parent === current) {
			throw new Error(
				`No ${PROJECT_CONFIG_FILENAME} found walking up from ${start}. ` +
					`Discovery is upward-only and never scans down, so run from inside your ` +
					`Epicenter folder (the folder that holds ${PROJECT_CONFIG_FILENAME}), ` +
					`pass \`-C <epicenter-root>\`, or run \`epicenter init\` to create one.`,
			);
		}
		current = parent;
	}
}
