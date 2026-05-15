import { YAML } from 'bun';

/**
 * Assemble a markdown string from YAML frontmatter and an optional body.
 *
 * Pure function: no I/O. Uses `Bun.YAML.stringify` for spec-compliant
 * serialization (handles quoting of booleans, numeric strings, special
 * characters, newlines, etc.). Undefined frontmatter values are stripped
 * (missing key); null values are preserved (YAML `null`) so nullable
 * fields survive a future round-trip.
 *
 * The body is written verbatim; callers that need link rewriting (e.g.
 * epicenter:// to [[wikilinks]]) apply it before passing the body in. The
 * materializer does this in its row-composition path, so persisted notes
 * round-trip through both link styles.
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
