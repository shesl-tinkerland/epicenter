/**
 * Markdown frontmatter helpers local to the opensidian playground.
 *
 * Used by the playground's `markdown_prepare` action, the `pushFromMarkdown`
 * script, and the playground tests. The workspace library deliberately does
 * not export these: they are vault-style scripting utilities, not workspace
 * primitives, so this playground owns its own copies. See the audit
 * transcript that produced the move for the asymmetric-wins reasoning.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import slugify from '@sindresorhus/slugify';
import { YAML } from 'bun';
import { generateId } from '@epicenter/workspace';
import filenamify from 'filenamify';

const MAX_SLUG_LENGTH = 50;

const FRONTMATTER_PATTERN =
	/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Parse a `---`-delimited YAML frontmatter block out of a markdown string,
 * returning `null` if the file does not have valid frontmatter. Tolerates a
 * UTF-8 BOM and both LF and CRLF line endings.
 */
export function parseMarkdownFile(content: string): {
	frontmatter: Record<string, unknown>;
	body: string | undefined;
} | null {
	const input = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
	const match = input.match(FRONTMATTER_PATTERN);
	if (!match) return null;

	const raw = match[1];
	if (!raw) return null;
	const frontmatter = YAML.parse(raw);
	if (typeof frontmatter !== 'object' || frontmatter === null) return null;

	const rawBody = input
		.slice(match[0].length)
		.replace(/^\r?\n/, '')
		.replace(/\r?\n$/, '');

	return {
		frontmatter: frontmatter as Record<string, unknown>,
		body: rawBody.length > 0 ? rawBody : undefined,
	};
}

/**
 * Assemble a `---`-delimited markdown file string from a frontmatter object
 * and an optional body. Undefined frontmatter values are dropped; null
 * values are preserved so nullable fields round-trip.
 */
export function assembleMarkdown(
	frontmatter: Record<string, unknown>,
	body?: string,
): string {
	const cleaned: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(frontmatter)) {
		if (value !== undefined) {
			cleaned[key] = value;
		}
	}
	const yaml = YAML.stringify(cleaned, null, 2);
	const yamlBlock = yaml.endsWith('\n') ? yaml : `${yaml}\n`;
	return body !== undefined
		? `---\n${yamlBlock}---\n\n${body}\n`
		: `---\n${yamlBlock}---\n`;
}

/**
 * Build a `{slugified-title}-{id}.md` filename, falling back to `{id}.md`
 * when the title is empty.
 */
export function toSlugFilename(
	title: string | undefined | null,
	id: string,
): string {
	if (!title || title.trim().length === 0) return `${id}.md`;
	const slug = slugify(title).slice(0, MAX_SLUG_LENGTH);
	const raw = slug ? `${slug}-${id}.md` : `${id}.md`;
	return filenamify(raw, { replacement: '-' });
}

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
