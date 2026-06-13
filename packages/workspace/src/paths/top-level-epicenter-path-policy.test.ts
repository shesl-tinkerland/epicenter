import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const ACTIVE_ROOTS = ['apps', 'examples', 'packages'];
const IGNORED_DIRS = new Set([
	'.git',
	'.svelte-kit',
	'dist',
	'docs',
	'node_modules',
	'specs',
	'target',
]);
const TEXT_EXTENSIONS = new Set([
	'.cjs',
	'.css',
	'.html',
	'.js',
	'.json',
	'.jsonc',
	'.md',
	'.mjs',
	'.rs',
	'.svelte',
	'.ts',
	'.tsx',
]);

const BANNED_PATTERNS = [
	/~\/\.epicenter/,
	/EPICENTER_HOME/,
	/epicenterPaths/,
	/\.epicenter\/auth/,
	/\.epicenter\/persistence/,
	/\.epicenter\/run/,
	/\.epicenter\/log/,
];

function* activeTextFiles(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		if (IGNORED_DIRS.has(entry)) continue;
		const path = join(dir, entry);
		const stat = statSync(path);
		if (stat.isDirectory()) {
			yield* activeTextFiles(path);
			continue;
		}
		if (!stat.isFile()) continue;
		if (!TEXT_EXTENSIONS.has(extname(path))) continue;
		if (basename(path).includes('.snap')) continue;
		if (basename(path) === 'top-level-epicenter-path-policy.test.ts') continue;
		yield path;
	}
}

describe('top-level .epicenter path policy', () => {
	test('active source does not reference machine-global ~/.epicenter paths', () => {
		const offenders: string[] = [];
		for (const root of ACTIVE_ROOTS) {
			for (const path of activeTextFiles(join(REPO_ROOT, root))) {
				const text = readFileSync(path, 'utf8');
				for (const pattern of BANNED_PATTERNS) {
					if (!pattern.test(text)) continue;
					offenders.push(`${path.replace(`${REPO_ROOT}/`, '')}: ${pattern}`);
				}
			}
		}

		expect(offenders).toEqual([]);
	});
});
