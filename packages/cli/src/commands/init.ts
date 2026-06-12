/**
 * `epicenter init [dir]`: scaffold a new Epicenter project.
 *
 * Writes the default `epicenter.config.ts` into the target directory (the
 * literal directory given; no project-root discovery, because init creates
 * the root). Idempotent: an existing config is left untouched.
 *
 * Project creation is an explicit user decision; `epicenter daemon up` never
 * scaffolds and instead points here when the config is missing.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_PROJECT_CONFIG_SOURCE } from '@epicenter/workspace/node';
import { cmd } from '../util/cmd.js';

export const initCommand = cmd({
	command: 'init [dir]',
	describe: 'Scaffold epicenter.config.ts in a directory.',
	builder: (yargs) =>
		yargs.positional('dir', {
			type: 'string',
			default: () => process.cwd(),
			defaultDescription: 'current working directory',
			describe: 'Directory to become the project root',
			coerce: (dir: string) => resolve(dir),
		}),
	handler: (argv) => {
		const projectConfigPath = join(argv.dir, 'epicenter.config.ts');
		if (existsSync(projectConfigPath)) {
			process.stderr.write(`${projectConfigPath} already exists; left as is\n`);
			return;
		}
		writeFileSync(projectConfigPath, DEFAULT_PROJECT_CONFIG_SOURCE, {
			mode: 0o600,
		});
		process.stdout.write(`created ${projectConfigPath}\n`);
	},
});
