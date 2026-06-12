/**
 * Matter Check Command Tests
 *
 * Exercises the app-local `check` package script against fixture folders. These
 * tests pin the command contract, not the UI: exit codes, default text, JSON
 * shape, fatal setup failures, and deterministic output.
 *
 * Key behaviors:
 * - Exit 0 for folders whose modeled cells are OK or MISSING_OPTIONAL
 * - Exit 1 for content failures and unreadable Markdown
 * - Exit 2 for folders the checker cannot certify
 */

import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const appRoot = resolve(import.meta.dir, '../../..');
const fixtureRoot = 'fixtures/check';
const mixedFixture = `${fixtureRoot}/mixed`;

type CommandResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
};

async function runCheck(args: string[]): Promise<CommandResult> {
	const proc = Bun.spawn(['bun', 'run', '--silent', 'check', ...args], {
		cwd: appRoot,
		stdout: 'pipe',
		stderr: 'pipe',
	});

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	return { exitCode, stdout, stderr };
}

describe('matter check command', () => {
	test('exit 0 prints the ready summary for a passing folder', async () => {
		const result = await runCheck([`${fixtureRoot}/pass`]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe('');
		expect(result.stdout).toBe('2 ready (2 files)\n');
	});

	test('exit 1 prints grouped findings for the mixed fixture', async () => {
		const result = await runCheck([mixedFixture]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe('');
		expect(result.stdout).toContain(`invalid-number.md
  duration      invalid: got "five", expected integer

invalid-status.md
  status        invalid: got "idea", expected one of draft, ready, published

missing-required.md
  status        needs value
  duration      needs value
`);
		expect(result.stdout).toContain(`broken-yaml.md
  can't read: frontmatter is not valid YAML:`);
		expect(result.stdout).toContain(`extras.md
  note: extra keys legacyId, mood, metadata

By field:
  status        1 needs value, 1 invalid
  duration      1 needs value, 1 invalid
`);
		expect(
			result.stdout.endsWith(
				'3 ready, 3 need attention, 1 unreadable (7 files)\n',
			),
		).toBe(true);
	});

	test('exit 1 JSON is CheckReport v1 and omits Markdown bodies', async () => {
		const result = await runCheck(['--json', mixedFixture]);
		const report = JSON.parse(result.stdout);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe('');
		expect(report).toEqual({
			version: 1,
			status: 'checked',
			folder: mixedFixture,
			model: {
				fields: [
					{ name: 'title', kind: 'string', required: true },
					{ name: 'status', kind: 'select', required: true },
					{ name: 'duration', kind: 'integer', required: true },
					{ name: 'url', kind: 'url', required: false },
					{ name: 'destinations', kind: 'multiSelect', required: false },
					{ name: 'published', kind: 'boolean', required: false },
				],
			},
			summary: {
				files: 7,
				ready: 3,
				needsAttention: 3,
				unreadable: 1,
			},
			findings: [
				{
					file: 'invalid-number.md',
					field: 'duration',
					state: 'INVALID',
					actual: 'five',
					expected: { kind: 'integer' },
				},
				{
					file: 'invalid-status.md',
					field: 'status',
					state: 'INVALID',
					actual: 'idea',
					expected: {
						kind: 'select',
						values: ['draft', 'ready', 'published'],
					},
				},
				{
					file: 'missing-required.md',
					field: 'status',
					state: 'NEEDS_VALUE',
				},
				{
					file: 'missing-required.md',
					field: 'duration',
					state: 'NEEDS_VALUE',
				},
			],
			byField: [
				{ field: 'title', ok: 6, empty: 0, needsValue: 0, invalid: 0 },
				{ field: 'status', ok: 4, empty: 0, needsValue: 1, invalid: 1 },
				{ field: 'duration', ok: 4, empty: 0, needsValue: 1, invalid: 1 },
				{ field: 'url', ok: 1, empty: 5, needsValue: 0, invalid: 0 },
				{
					field: 'destinations',
					ok: 1,
					empty: 5,
					needsValue: 0,
					invalid: 0,
				},
				{ field: 'published', ok: 1, empty: 5, needsValue: 0, invalid: 0 },
			],
			unreadable: [
				{
					file: 'broken-yaml.md',
					error: expect.stringContaining('Frontmatter is not valid YAML'),
				},
			],
			extras: [
				{
					file: 'extras.md',
					keys: ['legacyId', 'mood', 'metadata'],
				},
			],
		});
		expect(result.stdout).not.toContain(
			'This body must not appear in JSON output.',
		);
	});

	test('exit 2 reports missing matter.json as fatal', async () => {
		const result = await runCheck([`${fixtureRoot}/missing-model`]);

		expect(result.exitCode).toBe(2);
		expect(result.stdout).toBe('');
		expect(result.stderr).toBe(
			`cannot check ${fixtureRoot}/missing-model: matter.json is missing\n`,
		);
	});

	test('exit 1 reports conflict markers as unreadable Markdown', async () => {
		const folder = await mkdtemp(join(tmpdir(), 'matter-check-'));
		try {
			await writeFile(
				join(folder, 'matter.json'),
				JSON.stringify({
					fields: {
						title: { type: 'string' },
					},
				}),
			);
			await writeFile(
				join(folder, 'conflict.md'),
				[
					'<<<<<<< HEAD',
					'---',
					'title: Local',
					'---',
					'=======',
					'---',
					'title: Incoming',
					'---',
					'>>>>>>> branch',
				].join('\n'),
			);

			const result = await runCheck([folder]);

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toBe('');
			expect(result.stdout).toContain(`conflict.md
  can't read: contains git conflict markers`);
		} finally {
			await rm(folder, { recursive: true, force: true });
		}
	});

	test('exit 2 reports junk matter.json as JSON fatal output', async () => {
		const folder = await mkdtemp(join(tmpdir(), 'matter-check-'));
		try {
			await writeFile(join(folder, 'matter.json'), '{ not json\n');
			await writeFile(
				join(folder, 'ready.md'),
				['---', 'title: Junk model', '---', 'The model cannot be parsed.'].join(
					'\n',
				),
			);

			const result = await runCheck(['--json', folder]);
			const report = JSON.parse(result.stdout);

			expect(result.exitCode).toBe(2);
			expect(result.stderr).toBe('');
			expect(report).toMatchObject({
				version: 1,
				status: 'fatal',
				folder,
				fatal: {
					code: 'MODEL_INVALID',
					message: expect.stringContaining('matter.json is not valid JSON'),
				},
			});
		} finally {
			await rm(folder, { recursive: true, force: true });
		}
	});

	test('exit 2 reports unrecognized model fields as fatal', async () => {
		const result = await runCheck([`${fixtureRoot}/unrecognized-model`]);

		expect(result.exitCode).toBe(2);
		expect(result.stdout).toBe('');
		expect(result.stderr).toBe(
			`cannot check ${fixtureRoot}/unrecognized-model: field "status" is not a recognized Matter field\n`,
		);
	});

	test('exit 2 reports optional entries that do not match typed fields as fatal', async () => {
		const result = await runCheck([`${fixtureRoot}/unmatched-optional`]);

		expect(result.exitCode).toBe(2);
		expect(result.stdout).toBe('');
		expect(result.stderr).toBe(
			`cannot check ${fixtureRoot}/unmatched-optional: optional entry "missing" does not name a typed field\n`,
		);
	});

	test('default text output is deterministic across two runs', async () => {
		const first = await runCheck([mixedFixture]);
		const second = await runCheck([mixedFixture]);

		expect(first.exitCode).toBe(1);
		expect(second.exitCode).toBe(1);
		expect(first.stdout).toBe(second.stdout);
		expect(first.stderr).toBe(second.stderr);
	});
});
