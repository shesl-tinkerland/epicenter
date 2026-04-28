/**
 * CLI entry-point tests.
 *
 * The binary surfaces four commands: `auth`, `list`, `peers`, `run`. These
 * tests assert registration via `--help` output so they stay decoupled from
 * command semantics.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { createCLI } from './cli';

function captureHelp(): Promise<string> {
	const chunks: string[] = [];
	const logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
		chunks.push(args.map((a) => String(a)).join(' '));
	});
	const errSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
		chunks.push(args.map((a) => String(a)).join(' '));
	});
	return createCLI()
		.run(['--help'])
		.catch(() => {})
		.finally(() => {
			logSpy.mockRestore();
			errSpy.mockRestore();
		})
		.then(() => chunks.join('\n'));
}

describe('createCLI', () => {
	test('returns an object with a run method', () => {
		const cli = createCLI();
		expect(typeof cli.run).toBe('function');
	});

	test('rejects with usage when no arguments provided', async () => {
		const cli = createCLI();
		const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

		// exitProcess(false) makes yargs throw instead of calling process.exit
		await expect(cli.run([])).rejects.toThrow(
			'Not enough non-option arguments',
		);

		const errorOutput = errorSpy.mock.calls.flat().join(' ');
		expect(errorOutput).toContain('epicenter');
		errorSpy.mockRestore();
	});

	test('help output registers auth, list, peers, and run', async () => {
		const help = await captureHelp();
		expect(help).toMatch(/\bauth\b/);
		expect(help).toMatch(/\blist\b/);
		expect(help).toMatch(/\bpeers\b/);
		expect(help).toMatch(/\brun\b/);
	});
});
