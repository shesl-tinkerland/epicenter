/**
 * CLI entry-point tests.
 *
 * The binary surfaces daily workspace commands plus namespaced supporting
 * systems. These tests assert registration via `--help` output so they stay
 * decoupled from command semantics.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { createCLI } from './cli.js';

async function captureHelp(argv: string[] = ['--help']): Promise<string> {
	const chunks: string[] = [];
	const logSpy = spyOn(console, 'log').mockImplementation(
		(...args: unknown[]) => {
			chunks.push(args.map((a) => String(a)).join(' '));
		},
	);
	const errSpy = spyOn(console, 'error').mockImplementation(
		(...args: unknown[]) => {
			chunks.push(args.map((a) => String(a)).join(' '));
		},
	);
	try {
		await createCLI()
			.run(argv)
			.catch(() => {});
		return chunks.join('\n');
	} finally {
		logSpy.mockRestore();
		errSpy.mockRestore();
	}
}

describe('createCLI', () => {
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

	test('help output registers auth, daemon, list, peers, and run', async () => {
		const help = await captureHelp();
		expect(help).toMatch(/\bauth\b/);
		expect(help).toMatch(/\bdaemon\b/);
		expect(help).toMatch(/\blist\b/);
		expect(help).toMatch(/\bpeers\b/);
		expect(help).toMatch(/\brun\b/);
		expect(help).not.toMatch(/\bup\b/);
		expect(help).not.toMatch(/\bdown\b/);
		expect(help).not.toMatch(/\bps\b/);
		expect(help).not.toMatch(/\blogs\b/);
	});

	test('daemon help output registers lifecycle subcommands', async () => {
		const help = await captureHelp(['daemon', '--help']);
		expect(help).toMatch(/\bup\b/);
		expect(help).toMatch(/\bdown\b/);
		expect(help).toMatch(/\bps\b/);
		expect(help).toMatch(/\blogs\b/);
	});

	test('daemon without a subcommand shows daemon guidance', async () => {
		const help = await captureHelp(['daemon']);
		expect(help).toContain('Specify a subcommand: up, down, ps, or logs');
		expect(help).toMatch(/\bup\b/);
		expect(help).toMatch(/\bdown\b/);
		expect(help).toMatch(/\bps\b/);
		expect(help).toMatch(/\blogs\b/);
	});

	test('top-level daemon lifecycle commands are unknown', async () => {
		const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

		try {
			for (const command of ['up', 'down', 'ps', 'logs']) {
				await expect(createCLI().run([command])).rejects.toThrow(
					`Unknown argument: ${command}`,
				);
			}
		} finally {
			errorSpy.mockRestore();
		}
	});

	test('auth status rejects extra positionals', async () => {
		const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

		try {
			await expect(
				createCLI().run(['auth', 'status', 'not-a-url']),
			).rejects.toThrow('Unknown argument: not-a-url');
			expect(errorSpy.mock.calls.flat().join(' ')).toContain(
				'Unknown argument: not-a-url',
			);
		} finally {
			errorSpy.mockRestore();
		}
	});
});
