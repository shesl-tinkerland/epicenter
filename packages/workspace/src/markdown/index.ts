/**
 * Markdown file IO helpers: parse and emit `---`-fenced markdown files with
 * YAML frontmatter, plus the slug filename convention the workspace
 * materializer uses.
 *
 * Pure functions only. No coupling to workspace primitives (`Y.Doc`,
 * `Table`, `Kv`); intended for use by the materializer, by vault-style
 * scripts, and by external tools that want to share the same on-disk
 * conventions.
 */

export { assembleMarkdown } from './assemble-markdown.js';
export { parseMarkdownFile } from './parse-markdown-file.js';
export { toSlugFilename } from './to-slug-filename.js';
