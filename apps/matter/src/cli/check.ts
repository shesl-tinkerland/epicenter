import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type CheckInput, check } from '../lib/check/check';
import { exitCodeFor } from '../lib/check/exit-code';
import { formatCheckResult } from '../lib/check/format';
import type { CheckResult } from '../lib/check/report';
import { type FolderEntry, MatterReadError } from '../lib/core/folder';

type Args =
	| { json: boolean; folder: string }
	| { json: boolean; error: string };

type ModelInput = Extract<CheckInput, { kind: 'folder' }>['model'];

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		error.code === 'ENOENT'
	);
}

function parseArgs(argv: string[]): Args {
	let json = false;
	let folder: string | undefined;

	for (const arg of argv) {
		if (arg === '--json') {
			json = true;
			continue;
		}

		if (arg.startsWith('-')) {
			return { json, error: `unknown option ${arg}` };
		}

		if (folder !== undefined) {
			return { json, error: `expected one folder, got ${folder} and ${arg}` };
		}
		folder = arg;
	}

	return { json, folder: folder ?? '.' };
}

async function readModel(folderPath: string): Promise<ModelInput> {
	try {
		return {
			kind: 'loaded',
			text: await readFile(join(folderPath, 'matter.json'), 'utf8'),
		};
	} catch (error) {
		if (isNotFound(error)) return { kind: 'missing' };
		return { kind: 'unreadable', reason: messageOf(error) };
	}
}

async function readInput(folder: string): Promise<CheckInput> {
	const folderPath = resolve(folder);
	let names: string[];
	try {
		names = (await readdir(folderPath))
			.filter((name) => name.endsWith('.md'))
			.sort();
	} catch (error) {
		return {
			kind: 'folder-unreadable',
			folder,
			reason: messageOf(error),
		};
	}

	const entries = await Promise.all(
		names.map(async (fileName): Promise<FolderEntry> => {
			try {
				return {
					fileName,
					content: await readFile(join(folderPath, fileName), 'utf8'),
				};
			} catch (cause) {
				return {
					fileName,
					error: MatterReadError.ReadFailed({ cause }).error,
				};
			}
		}),
	);

	return {
		kind: 'folder',
		folder,
		entries,
		model: await readModel(folderPath),
	};
}

function writeResult(report: CheckResult, json: boolean): void {
	if (json) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		return;
	}

	const text = `${formatCheckResult(report)}\n`;
	if (report.status === 'fatal') {
		process.stderr.write(text);
	} else {
		process.stdout.write(text);
	}
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	if ('error' in args) {
		process.stderr.write(`${args.error}\n`);
		return 2;
	}

	const result = check(await readInput(args.folder));
	writeResult(result, args.json);
	return exitCodeFor(result);
}

process.exitCode = await main();
