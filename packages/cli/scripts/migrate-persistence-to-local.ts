#!/usr/bin/env bun
/**
 * One-time migration: move per-workspace SQLite persistence files from
 *   ~/.epicenter/persistence/<id>.db
 * to the new local convention:
 *   <absDir>/.epicenter/persistence/<id>.db
 *
 * Usage:
 *   bun packages/cli/scripts/migrate-persistence-to-local.ts
 *   bun packages/cli/scripts/migrate-persistence-to-local.ts --from <workspaceId> --to <absDir>
 *   bun packages/cli/scripts/migrate-persistence-to-local.ts --yes
 *
 * Without flags, the script lists each global persistence file and prompts
 * for the absDir that owns it. With `--from <id> --to <absDir>`, it moves a
 * single file non-interactively. Refuses to overwrite an existing destination.
 *
 * Honors `$EPICENTER_HOME` (defaults to `~/.epicenter`).
 */

import { mkdir, readdir, rename, copyFile, unlink, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

type Args = {
	from?: string;
	to?: string;
	yes: boolean;
};

function parseArgs(argv: string[]): Args {
	const args: Args = { yes: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--from') args.from = argv[++i];
		else if (a === '--to') args.to = argv[++i];
		else if (a === '--yes' || a === '-y') args.yes = true;
		else if (a === '--help' || a === '-h') {
			console.log(
				'Usage: migrate-persistence-to-local [--from <id> --to <absDir>] [--yes]',
			);
			process.exit(0);
		} else {
			console.error(`Unknown arg: ${a}`);
			process.exit(2);
		}
	}
	return args;
}

function epicenterHome(): string {
	return process.env.EPICENTER_HOME ?? join(homedir(), '.epicenter');
}

function globalPersistenceDir(): string {
	return join(epicenterHome(), 'persistence');
}

function localPersistenceFile(absDir: string, workspaceId: string): string {
	return join(absDir, '.epicenter', 'persistence', `${workspaceId}.db`);
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function moveFile(src: string, dst: string): Promise<void> {
	await mkdir(dirname(dst), { recursive: true });
	try {
		await rename(src, dst);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
			await copyFile(src, dst);
			await unlink(src);
		} else {
			throw err;
		}
	}
}

async function migrateOne(
	workspaceId: string,
	srcFile: string,
	absDir: string,
	yes: boolean,
	rl: ReturnType<typeof createInterface> | null,
): Promise<boolean> {
	const dstFile = localPersistenceFile(absDir, workspaceId);

	if (await exists(dstFile)) {
		console.error(
			`Refusing to overwrite existing destination: ${dstFile}\n  Inspect both files and resolve manually.`,
		);
		return false;
	}

	console.log(`  from: ${srcFile}`);
	console.log(`    to: ${dstFile}`);

	if (!yes && rl) {
		const ans = (await rl.question('Move this file? [y/N] ')).trim().toLowerCase();
		if (ans !== 'y' && ans !== 'yes') {
			console.log('  skipped.');
			return false;
		}
	}

	await moveFile(srcFile, dstFile);
	console.log(`  done. Removed ${srcFile}`);
	return true;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const dir = globalPersistenceDir();

	if (!(await exists(dir))) {
		console.log(`Nothing to migrate: ${dir} does not exist.`);
		return;
	}

	const entries = (await readdir(dir)).filter((f) => f.endsWith('.db'));
	if (entries.length === 0) {
		console.log(`Nothing to migrate: no .db files in ${dir}.`);
		return;
	}

	const rl = args.yes ? null : createInterface({ input: process.stdin, output: process.stdout });

	try {
		// Targeted single-file mode.
		if (args.from && args.to) {
			const srcFile = join(dir, `${args.from}.db`);
			if (!(await exists(srcFile))) {
				console.error(`No such file: ${srcFile}`);
				process.exit(1);
			}
			const absDir = resolve(args.to);
			const moved = await migrateOne(args.from, srcFile, absDir, args.yes, rl);
			process.exit(moved ? 0 : 1);
		}

		if (args.from || args.to) {
			console.error('--from and --to must be used together.');
			process.exit(2);
		}

		// Interactive mode: walk every .db file and prompt.
		console.log(`Found ${entries.length} persistence file(s) in ${dir}:`);
		for (const file of entries) {
			console.log(`  - ${file}`);
		}
		console.log('');

		for (const file of entries) {
			const workspaceId = file.replace(/\.db$/, '');
			const srcFile = join(dir, file);
			console.log(`Workspace: ${workspaceId}`);
			let absDir: string | undefined;
			while (rl && !absDir) {
				const ans = (await rl.question('  absDir that owns it (absolute path, or blank to skip): ')).trim();
				if (!ans) {
					absDir = undefined;
					break;
				}
				const resolved = resolve(ans);
				if (!(await exists(resolved))) {
					console.error(`  ${resolved} does not exist. Try again.`);
					continue;
				}
				absDir = resolved;
			}
			if (!absDir) {
				console.log('  skipped.');
				continue;
			}
			await migrateOne(workspaceId, srcFile, absDir, args.yes, rl);
			console.log('');
		}

		console.log('Done.');
	} finally {
		rl?.close();
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
