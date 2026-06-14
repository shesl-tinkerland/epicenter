/**
 * Tauri-backed injection deps for `attachMarkdownExport`: a `MarkdownExportFs`
 * over `@tauri-apps/plugin-fs`, paired with a browser-safe `js-yaml` serializer.
 *
 * The workspace markdown engine carries no filesystem or YAML runtime of its own
 * (see `@epicenter/workspace/document/materializer/markdown`); the daemon injects
 * the `node:fs`/`Bun.YAML` pair, and the Whispering desktop app injects this one
 * so it can continuously materialize recordings to disk inside the webview, where
 * `node:*` and `bun` are unavailable.
 *
 * This module eagerly imports Tauri plugins, so it is only ever imported from
 * `whispering.tauri.ts` (the desktop runtime), never from browser code.
 */

import type {
	AssembleMarkdown,
	MarkdownExportFs,
} from '@epicenter/workspace/document/materializer/markdown';
import { dirname, join } from '@tauri-apps/api/path';
import {
	exists,
	mkdir,
	readDir,
	remove,
	writeTextFile,
} from '@tauri-apps/plugin-fs';
import yaml from 'js-yaml';
import { commands } from '$lib/tauri/commands';

/** Resolve a "/"-relative export path to an absolute path under `baseDir`. */
function toAbsolute(baseDir: string, relPath: string): Promise<string> {
	return join(baseDir, ...relPath.split('/'));
}

/**
 * List every file under `absDir`, recursively, as "/"-relative paths. Tauri's
 * `readDir` is single-level, so the recursion is explicit. A missing directory
 * resolves to `[]`, matching the engine's orphan-sweep contract.
 */
async function listFilesRecursive(absDir: string): Promise<string[]> {
	let entries: Awaited<ReturnType<typeof readDir>>;
	try {
		entries = await readDir(absDir);
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		if (entry.isDirectory) {
			const childDir = await join(absDir, entry.name);
			for (const nested of await listFilesRecursive(childDir)) {
				files.push(`${entry.name}/${nested}`);
			}
		} else {
			files.push(entry.name);
		}
	}
	return files;
}

/**
 * The markdown export's filesystem surface, backed by `@tauri-apps/plugin-fs`.
 * `writeFiles` routes a flat (leaf-filename) batch through the existing
 * `write_markdown_files` Rust command for an atomic, single-invoke cold-start
 * flush, falling back to per-file writes for any nested relPath.
 */
export function createTauriFs(): MarkdownExportFs {
	const fs: MarkdownExportFs = {
		async ensureDir(baseDir, subDir) {
			const target = subDir ? await toAbsolute(baseDir, subDir) : baseDir;
			await mkdir(target, { recursive: true });
		},
		async writeFile(baseDir, relPath, content) {
			const abs = await toAbsolute(baseDir, relPath);
			await mkdir(await dirname(abs), { recursive: true });
			await writeTextFile(abs, content);
		},
		async removeFile(baseDir, relPath) {
			// `exists` first so an already-gone file is a no-op, satisfying the
			// engine's best-effort delete contract without swallowing real errors.
			const abs = await toAbsolute(baseDir, relPath);
			if (await exists(abs)) await remove(abs);
		},
		async listFiles(baseDir) {
			return listFilesRecursive(baseDir);
		},
		async writeFiles(baseDir, files) {
			const leaves = files.filter((file) => !file.relPath.includes('/'));
			const nested = files.filter((file) => file.relPath.includes('/'));
			if (leaves.length > 0) {
				const { error } = await commands.writeMarkdownFiles(
					baseDir,
					leaves.map((file) => ({
						filename: file.relPath,
						content: file.content,
					})),
				);
				if (error !== null) throw error;
			}
			for (const file of nested) {
				await fs.writeFile(baseDir, file.relPath, file.content);
			}
		},
	};
	return fs;
}

/**
 * Serialize frontmatter + body into a `---`-fenced markdown file using `js-yaml`
 * (the browser-safe sibling of the daemon's `Bun.YAML` assembler). `skipInvalid`
 * drops `undefined` frontmatter values, the same way the daemon assembler strips
 * missing keys; `null` is preserved as YAML `null`.
 */
export const assembleMarkdown: AssembleMarkdown = (frontmatter, body) => {
	const frontmatterYaml = yaml.dump(frontmatter, {
		lineWidth: -1,
		skipInvalid: true,
	});
	return `---\n${frontmatterYaml}---\n${body ?? ''}\n`;
};

/**
 * The Tauri injection bundle for `attachMarkdownExport`. Spread into the options
 * at the call site: `attachMarkdownExport(workspace, { dir, ...tauriMarkdownDeps,
 * tables })`.
 */
export const tauriMarkdownDeps: {
	fs: MarkdownExportFs;
	assemble: AssembleMarkdown;
} = {
	fs: createTauriFs(),
	assemble: assembleMarkdown,
};
