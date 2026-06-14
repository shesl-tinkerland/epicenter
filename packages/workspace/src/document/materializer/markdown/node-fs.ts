/**
 * Node/Bun filesystem adapter for the markdown export, plus the convenience
 * `nodeMarkdownDeps` bundle that pairs it with the `Bun.YAML`-backed serializer.
 *
 * This module imports `node:*` (and, through `assembleMarkdown`, `bun`), so it is
 * exported only from `@epicenter/workspace/node`, never from the webview-safe
 * markdown barrel. A Tauri webview supplies its own `MarkdownExportFs` instead
 * (see Whispering's `createTauriFs`).
 */

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { assembleMarkdown } from '../../../markdown/assemble-markdown.js';
import type { AssembleMarkdown, MarkdownExportFs } from './export.js';

/** Join a "/"-relative export path onto a base dir with the platform separator. */
function toAbsolute(baseDir: string, relPath: string): string {
	return join(baseDir, ...relPath.split('/'));
}

/**
 * The markdown export's filesystem surface, backed by `node:fs/promises`. Bun
 * implements the same `node:fs` API, so this one adapter serves both runtimes;
 * there is no separate Bun adapter unless `Bun.write` throughput ever warrants it.
 */
export function createNodeFs(): MarkdownExportFs {
	return {
		async ensureDir(baseDir, subDir) {
			const target = subDir ? toAbsolute(baseDir, subDir) : baseDir;
			await mkdir(target, { recursive: true });
		},
		async writeFile(baseDir, relPath, content) {
			const abs = toAbsolute(baseDir, relPath);
			await mkdir(dirname(abs), { recursive: true });
			await writeFile(abs, content);
		},
		async removeFile(baseDir, relPath) {
			// `force` makes an already-gone file a no-op, satisfying the engine's
			// best-effort delete contract; other errors propagate to its catch.
			await rm(toAbsolute(baseDir, relPath), { force: true });
		},
		async listFiles(baseDir) {
			try {
				const entries = await readdir(baseDir, { recursive: true });
				// `readdir` returns platform-separated paths relative to baseDir;
				// normalize to the engine's "/" canon. Directory entries are harmless:
				// the engine filters to `.md`, and a remove of a stray dir is caught.
				return entries.map((e) => e.split(sep).join('/'));
			} catch {
				// baseDir does not exist yet.
				return [];
			}
		},
	};
}

/**
 * The node/bun injection bundle for `attachMarkdownExport`: the node filesystem
 * adapter paired with the `Bun.YAML` serializer. Spread into the options at a call
 * site: `attachMarkdownExport(workspace, { dir, ...nodeMarkdownDeps, tables })`.
 */
export const nodeMarkdownDeps: {
	fs: MarkdownExportFs;
	assemble: AssembleMarkdown;
} = {
	fs: createNodeFs(),
	assemble: assembleMarkdown,
};
