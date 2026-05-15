/**
 * Vault recipe local to the opensidian playground: walk a flat directory
 * of `.md` files and inject a generated `id` into the frontmatter of any
 * file missing one, aborting on id collisions.
 *
 * Built on top of the workspace's markdown primitives
 * (`@epicenter/workspace/markdown`). Lives here because the "flat
 * directory, `id` field, abort on collision" convention is too
 * vault-specific for the library to maintain.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateId } from '@epicenter/workspace';
import {
	assembleMarkdown,
	parseMarkdownFile,
} from '@epicenter/workspace/markdown';

type PrepareResult = {
	prepared: number;
	skipped: number;
	errors: string[];
};

/**
 * Walk a directory of `.md` files and inject a generated `id` into the
 * frontmatter of any file missing one. Aborts (zero writes) if any
 * existing files share an id.
 */
export async function prepareMarkdownFiles(
	directory: string,
): Promise<PrepareResult> {
	const entries = await readdir(directory);
	const mdFiles = entries.filter((f) => f.endsWith('.md'));

	const idToFiles = new Map<string, string[]>();
	const filesToPrepare: {
		filename: string;
		frontmatter: Record<string, unknown>;
		body: string | undefined;
	}[] = [];
	let skipped = 0;

	for (const filename of mdFiles) {
		const filePath = join(directory, filename);
		const content = await readFile(filePath, 'utf-8');
		const parsed = parseMarkdownFile(content);

		if (!parsed) {
			skipped++;
			continue;
		}

		const { frontmatter, body } = parsed;
		const existingId = frontmatter.id;

		if (typeof existingId === 'string' && existingId.length > 0) {
			const existing = idToFiles.get(existingId) ?? [];
			existing.push(filename);
			idToFiles.set(existingId, existing);
			skipped++;
		} else {
			filesToPrepare.push({ filename, frontmatter, body });
		}
	}

	const errors: string[] = [];
	for (const [id, files] of idToFiles) {
		if (files.length > 1) {
			errors.push(`Duplicate id "${id}" found in: ${files.join(', ')}`);
		}
	}

	if (errors.length > 0) {
		return { prepared: 0, skipped, errors };
	}

	for (const { filename, frontmatter, body } of filesToPrepare) {
		const filePath = join(directory, filename);
		const newId = generateId();
		const updatedFrontmatter = { id: newId, ...frontmatter };
		const markdown = assembleMarkdown(updatedFrontmatter, body);
		await writeFile(filePath, markdown, 'utf-8');
	}

	return { prepared: filesToPrepare.length, skipped, errors: [] };
}
