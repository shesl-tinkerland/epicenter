import yargs from 'yargs';

import packageJson from '../package.json' with { type: 'json' };
import { authCommand } from './commands/auth';
import { downCommand } from './commands/down';
import { listCommand } from './commands/list';
import { logsCommand } from './commands/logs';
import { peersCommand } from './commands/peers';
import { psCommand } from './commands/ps';
import { runCommand } from './commands/run';
import { upCommand } from './commands/up';

const CLI_VERSION = packageJson.version;

const EPILOG = `Scripting: import \`epicenter.config.ts\` in a \`.ts\` script and run with \`bun run\`.
The CLI is the shell-friendly surface for one-shot queries and invocations;
loops, fan-out, and joins belong in scripts that call the workspace library directly.`;

/**
 * Create the Epicenter CLI instance.
 *
 * Introspect and invoke `defineQuery` / `defineMutation` actions in
 * `epicenter.config.ts`, either locally or on a peer that's online right now.
 *
 *   - `auth`:  manage Epicenter server sessions (pre-workspace)
 *   - `list`:  tree view of runnable actions (local schema is authoritative)
 *   - `run`:   invoke one by dot-path; `--peer` dispatches over RPC
 *   - `peers`: enumerate other clients currently online via Yjs awareness
 *
 * Specs: `specs/20260421T155436-cli-scripting-first-redesign.md` (base
 * surface), `specs/20260423T174126-cli-remote-peer-rpc.md` (`peers` + `--peer`).
 */
export function createCLI() {
	return {
		run: async (argv: string[]) => {
			const cli = yargs()
				.scriptName('epicenter')
				.usage('$0 <command> [options]')
				.command(authCommand)
				.command(downCommand)
				.command(listCommand)
				.command(logsCommand)
				.command(peersCommand)
				.command(psCommand)
				.command(runCommand)
				.command(upCommand)
				.demandCommand(1, 'Specify a command (run `$0 --help` to see all).')
				.recommendCommands()
				.strict()
				.exitProcess(false)
				.version(CLI_VERSION)
				.alias('v', 'version')
				.help()
				.alias('h', 'help')
				.epilog(EPILOG);

			await cli.parse(argv);
		},
	};
}
