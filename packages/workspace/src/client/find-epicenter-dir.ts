/**
 * Walk up from `start` (default cwd) looking for the first directory that
 * contains `epicenter.config.ts` or a `.epicenter/` directory. Returns the
 * absolute path of that directory.
 *
 * Used by `connectDaemon` so vault scripts don't have to pass `absDir`
 * explicitly: running a script from anywhere inside the vault tree resolves
 * the same daemon socket the surrounding `epicenter serve` is bound to.
 *
 * Throws if neither marker is found before reaching the filesystem root.
 *
 * Phase 6 of `specs/20260429T004302-workspace-as-daemon-transport.md`.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function findEpicenterDir(start: string = process.cwd()): string {
	let current = resolve(start);
	while (true) {
		const hasConfig = existsSync(join(current, 'epicenter.config.ts'));
		const hasDir = existsSync(join(current, '.epicenter'));
		if (hasConfig || hasDir) return current;
		const parent = dirname(current);
		if (parent === current) {
			throw new Error(
				`findEpicenterDir: no epicenter.config.ts or .epicenter/ directory found ` +
					`walking up from ${start}`,
			);
		}
		current = parent;
	}
}
