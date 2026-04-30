/**
 * CLI entry-point tests.
 *
 * The binary surfaces the workspace command registry. These
 * tests assert registration via `--help` output so they stay decoupled from
 * command semantics.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { createCLI } from './cli';

async function captureCliOutput(argv: string[]): Promise<string> {
	const chunks: string[] = [];
	const logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
		chunks.push(args.map((a) => String(a)).join(' '));
	});
	const errSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
		chunks.push(args.map((a) => String(a)).join(' '));
	});
	try {
		await createCLI().run(argv);
	} catch {
		// Some usage paths render help and then reject.
	} finally {
		logSpy.mockRestore();
		errSpy.mockRestore();
	}
	return chunks.join('\n');
}

describe('createCLI', () => {
	test('returns an object with a run method', () => {
		const cli = createCLI();
		expect(typeof cli.run).toBe('function');
	});

	test('rejects with usage when no arguments provided', async () => {
		const cli = createCLI();
		const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

		await expect(cli.run([])).rejects.toThrow('No command specified');

		const errorOutput = errorSpy.mock.calls.flat().join(' ');
		expect(errorOutput).toContain('epicenter');
		errorSpy.mockRestore();
	});

	test('help output registers every top-level command', async () => {
		const help = await captureCliOutput(['--help']);
		expect(help).toMatch(/\bauth\b/);
		expect(help).toMatch(/\bdown\b/);
		expect(help).toMatch(/\blist\b/);
		expect(help).toMatch(/\blogs\b/);
		expect(help).toMatch(/\bpeers\b/);
		expect(help).toMatch(/\bps\b/);
		expect(help).toMatch(/\brun\b/);
		expect(help).toMatch(/\bup\b/);
	});

	test('auth help output registers auth subcommands', async () => {
		const help = await captureCliOutput(['auth', '--help']);
		expect(help).toMatch(/\blogin\b/);
		expect(help).toMatch(/\blogout\b/);
		expect(help).toMatch(/\bstatus\b/);
	});

	test('run help output includes action, input, peer, wait, format, and project selection', async () => {
		const help = await captureCliOutput(['run', '--help']);
		expect(help).toMatch(/\bACTION\b/);
		expect(help).toMatch(/\bINPUT\b/);
		expect(help).toContain('--peer');
		expect(help).toContain('--wait');
		expect(help).toContain('--format');
		expect(help).toContain('--project');
		expect(help).toContain('-C');
	});

	test('run rejects --wait without --peer before daemon lookup', async () => {
		await expect(
			createCLI().run(['run', 'notes.list', '--wait', '1000']),
		).rejects.toThrow('--wait requires --peer');
	});
});
