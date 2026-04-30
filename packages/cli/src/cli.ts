import {
	defineCommand,
	renderUsage,
	runCommand as runCittyCommand,
	type CommandDef,
} from 'citty';
import { authCommand } from './commands/auth';
import { downCommand } from './commands/down';
import { listCommand } from './commands/list';
import { logsCommand } from './commands/logs';
import { peersCommand } from './commands/peers';
import { psCommand } from './commands/ps';
import { runCommand } from './commands/run';
import { upCommand } from './commands/up';

export const mainCommand = defineCommand({
	meta: {
		name: 'epicenter',
		description:
			'Introspect and invoke Epicenter workspace actions locally or on a live peer.',
	},
	subCommands: {
		auth: authCommand,
		down: downCommand,
		list: listCommand,
		logs: logsCommand,
		peers: peersCommand,
		ps: psCommand,
		run: runCommand,
		up: upCommand,
	},
});

/**
 * Run the Epicenter CLI with already-sliced user arguments.
 *
 * `bin.ts` passes `process.argv.slice(2)`, while tests pass explicit arrays.
 * This keeps the CLI testable without letting citty call `process.exit()`.
 */
export async function runCli(argv: string[]): Promise<void> {
	if (argv.includes('--help') || argv.includes('-h')) {
		const [command, parent] = findHelpCommand(mainCommand, argv);
		console.log(`${await renderUsage(command, parent)}\n`);
		return;
	}

	if (argv.length === 0) {
		console.error(`${await renderUsage(mainCommand)}\n`);
		throw new Error('No command specified.');
	}

	await runCittyCommand(mainCommand, { rawArgs: argv });
}

function findHelpCommand(
	command: CommandDef,
	argv: string[],
	parent?: CommandDef,
): [CommandDef, CommandDef | undefined] {
	const subCommands = getStaticSubCommands(command);
	if (!subCommands) return [command, parent];

	for (const [index, arg] of argv.entries()) {
		if (arg === '--help' || arg === '-h') continue;
		if (arg.startsWith('-')) continue;

		const subCommand = subCommands[arg];
		if (subCommand) {
			return findHelpCommand(
				subCommand,
				argv.slice(index + 1),
				command,
			);
		}
		return [command, parent];
	}
	return [command, parent];
}

function getStaticSubCommands(
	command: CommandDef,
): Record<string, CommandDef> | undefined {
	const { subCommands } = command;
	if (
		subCommands === undefined ||
		typeof subCommands === 'function' ||
		subCommands instanceof Promise
	) {
		return undefined;
	}

	const staticSubCommands: Record<string, CommandDef> = {};
	for (const [name, subCommand] of Object.entries(subCommands)) {
		if (
			subCommand === undefined ||
			typeof subCommand === 'function' ||
			subCommand instanceof Promise
		) {
			continue;
		}
		staticSubCommands[name] = subCommand;
	}
	return staticSubCommands;
}
