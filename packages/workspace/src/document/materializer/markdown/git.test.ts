/**
 * Git Autosave Tests
 *
 * Verifies the standalone `attachGitAutosave` primitive against real file
 * writes and real temporary Git repositories. The primitive knows nothing about
 * Yjs rows or the markdown vault: it fs-watches a directory and debounce-commits
 * whatever changes there. It only borrows a Y.Doc for its lifecycle, disposing
 * the watcher when the doc is destroyed.
 *
 * Key behaviors:
 * - file writes in the watched dir produce a debounced autosave commit
 * - configured and default authors apply per commit without mutating git config
 * - a non-repo directory logs once and otherwise no-ops, leaving files on disk
 * - destroying the Y.Doc closes the watcher so later writes are not committed
 *
 * fs.watch is event-timing-sensitive, so these tests always await
 * `whenWatching` before writing, keep `quietMs` small, and poll for commits
 * with a generous deadline rather than asserting exact change counts.
 */

import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'wellcrafted/logger';
import { createWorkspace } from '../../../index.js';
import { attachGitAutosave, type GitAutosaveConfig } from './git-autosave.js';

type GitResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
};

function createTestLogger() {
	const messages = {
		info: [] as string[],
		warn: [] as string[],
		error: [] as string[],
	};
	const logger = {
		error(value: unknown): void {
			messages.error.push(logMessage(value));
		},
		warn(value: unknown): void {
			messages.warn.push(logMessage(value));
		},
		info(message: string): void {
			messages.info.push(message);
		},
		debug(): void {},
		trace(): void {},
	} satisfies Logger;
	return { logger, messages };
}

function logMessage(value: unknown): string {
	if (value && typeof value === 'object') {
		if ('message' in value) return String(value.message);
		if ('error' in value) {
			const error = (value as { error?: unknown }).error;
			if (error && typeof error === 'object' && 'message' in error) {
				return String(error.message);
			}
		}
	}
	return String(value);
}

function setupProject() {
	const epicenterRoot = mkdtempSync(join(tmpdir(), 'git-autosave-'));
	const markdownDir = join(epicenterRoot, 'markdown');
	mkdirSync(markdownDir, { recursive: true });
	const logs = createTestLogger();

	return {
		epicenterRoot,
		markdownDir,
		logs,
		async initGitRepo(): Promise<void> {
			await runGit(epicenterRoot, ['init', '-q', '-b', 'main']);
			await runGit(epicenterRoot, ['config', 'user.name', 'Repo User']);
			await runGit(epicenterRoot, ['config', 'user.email', 'repo@example.com']);
			writeFileSync(join(epicenterRoot, '.gitignore'), '.epicenter/\n');
			await runGit(epicenterRoot, ['add', '.gitignore']);
			await runGit(epicenterRoot, ['commit', '-q', '-m', 'init']);
		},
		/**
		 * Build a Y.Doc and attach the autosave watcher to `markdownDir`. Returns
		 * the doc plus the autosave handle and a disposer that destroys the doc
		 * (which closes the watcher).
		 */
		attach(config?: GitAutosaveConfig) {
			const { ydoc } = createWorkspace({
				id: `git-autosave-${randomUUID()}`,
				tables: {},
				kv: {},
			});
			const autosave = attachGitAutosave({
				ydoc,
				dir: markdownDir,
				config,
				log: logs.logger,
			});
			return {
				ydoc,
				autosave,
				dispose(): void {
					ydoc.destroy();
				},
			};
		},
		cleanup(): void {
			rmSync(epicenterRoot, { recursive: true, force: true });
		},
	};
}

async function runGit(
	cwd: string,
	args: readonly string[],
): Promise<GitResult> {
	const proc = Bun.spawn(['git', ...args], {
		cwd,
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

async function commitCount(epicenterRoot: string): Promise<number> {
	const result = await runGit(epicenterRoot, ['rev-list', '--count', 'HEAD']);
	return Number(result.stdout.trim());
}

async function lastCommitSubject(epicenterRoot: string): Promise<string> {
	const result = await runGit(epicenterRoot, ['log', '-1', '--format=%s']);
	return result.stdout.trim();
}

async function lastCommitAuthor(epicenterRoot: string): Promise<string> {
	const result = await runGit(epicenterRoot, [
		'log',
		'-1',
		'--format=%an <%ae>',
	]);
	return result.stdout.trim();
}

/**
 * Poll until the repo reaches at least `expected` commits or the deadline
 * passes. fs.watch timing is not deterministic, so the deadline is generous.
 */
async function waitForCommitCount(
	epicenterRoot: string,
	expected: number,
	timeoutMs = 5_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if ((await commitCount(epicenterRoot)) >= expected) return;
		await Bun.sleep(10);
	}
	expect(await commitCount(epicenterRoot)).toBeGreaterThanOrEqual(expected);
}

describe('attachGitAutosave', () => {
	test('commits file changes in a git repo', async () => {
		const project = setupProject();
		try {
			await project.initGitRepo();
			const before = await commitCount(project.epicenterRoot);

			const handle = project.attach({ quietMs: 20, maxBatchMs: 1_000 });
			await handle.autosave.whenWatching;

			writeFileSync(join(project.markdownDir, 'alpha.md'), '# Alpha\n');
			writeFileSync(join(project.markdownDir, 'beta.md'), '# Beta\n');

			await waitForCommitCount(project.epicenterRoot, before + 1);

			expect(await lastCommitSubject(project.epicenterRoot)).toMatch(
				/^Autosave \(\d+ changes\)$/,
			);
			const tracked = await runGit(project.epicenterRoot, [
				'ls-files',
				'markdown',
			]);
			expect(tracked.stdout).toContain('markdown/alpha.md');
			expect(tracked.stdout).toContain('markdown/beta.md');

			handle.dispose();
		} finally {
			project.cleanup();
		}
	});

	test('configured author applies per commit without mutating git config', async () => {
		const project = setupProject();
		try {
			await project.initGitRepo();
			const before = await commitCount(project.epicenterRoot);

			const handle = project.attach({
				author: { name: 'Configured Bot', email: 'bot@example.com' },
				quietMs: 20,
				maxBatchMs: 1_000,
			});
			await handle.autosave.whenWatching;

			writeFileSync(
				join(project.markdownDir, 'configured-author.md'),
				'# Configured\n',
			);

			await waitForCommitCount(project.epicenterRoot, before + 1);

			expect(await lastCommitAuthor(project.epicenterRoot)).toBe(
				'Configured Bot <bot@example.com>',
			);
			expect(
				(
					await runGit(project.epicenterRoot, ['config', 'user.name'])
				).stdout.trim(),
			).toBe('Repo User');
			expect(
				(
					await runGit(project.epicenterRoot, ['config', 'user.email'])
				).stdout.trim(),
			).toBe('repo@example.com');

			handle.dispose();
		} finally {
			project.cleanup();
		}
	});

	test('default author uses synthetic autosave identity', async () => {
		const project = setupProject();
		try {
			await project.initGitRepo();
			const before = await commitCount(project.epicenterRoot);

			const handle = project.attach({ quietMs: 20, maxBatchMs: 1_000 });
			await handle.autosave.whenWatching;

			writeFileSync(
				join(project.markdownDir, 'default-author.md'),
				'# Default\n',
			);

			await waitForCommitCount(project.epicenterRoot, before + 1);

			expect(await lastCommitAuthor(project.epicenterRoot)).toBe(
				'Autosave <autosave@epicenter.local>',
			);

			handle.dispose();
		} finally {
			project.cleanup();
		}
	});

	test('non-repo directory logs once and leaves writes on disk', async () => {
		const project = setupProject();
		try {
			const handle = project.attach({ quietMs: 20, maxBatchMs: 1_000 });
			await handle.autosave.whenWatching;

			writeFileSync(
				join(project.markdownDir, 'outside-repo.md'),
				'# Outside\n',
			);
			await Bun.sleep(120);

			expect(project.logs.messages.info).toEqual([
				'git autosave: not in a git repo; skipping',
			]);
			expect(project.logs.messages.warn).toEqual([]);
			expect(
				readFileSync(join(project.markdownDir, 'outside-repo.md'), 'utf8'),
			).toContain('# Outside');

			handle.dispose();
		} finally {
			project.cleanup();
		}
	});

	test('disposing the Y.Doc stops autosave', async () => {
		const project = setupProject();
		try {
			await project.initGitRepo();

			const handle = project.attach({ quietMs: 20, maxBatchMs: 1_000 });
			await handle.autosave.whenWatching;

			writeFileSync(join(project.markdownDir, 'before-dispose.md'), '# One\n');
			await waitForCommitCount(project.epicenterRoot, 2);
			const afterFirstCommit = await commitCount(project.epicenterRoot);

			handle.dispose();

			writeFileSync(join(project.markdownDir, 'after-dispose.md'), '# Two\n');
			await Bun.sleep(200);

			expect(await commitCount(project.epicenterRoot)).toBe(afterFirstCommit);
			expect(project.logs.messages.warn).toEqual([]);
		} finally {
			project.cleanup();
		}
	});
});
