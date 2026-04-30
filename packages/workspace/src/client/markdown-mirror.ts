/**
 * Read-only handle on the daemon's materialized markdown tree.
 *
 * The daemon's `attachMarkdownMaterializer` writes per-table subdirectories
 * of `.md` files under `markdownPath(absDir, ydoc.guid)`. Script peers
 * walk the same tree via `attachMarkdownMirror({ rootPath })`, getting a
 * minimal listing + read surface without redoing the daemon's serialization
 * work and without paying for a chokidar watch (deferred to a later
 * version if a real consumer needs it).
 *
 * Output handle:
 *   { rootPath, list(prefix?), read(id), [Symbol.dispose]() }
 *
 * `list` is an async iterable of `{ id, path }` entries where `id` is the
 * file's relative path from `rootPath` minus the `.md` suffix and `path`
 * is the absolute on-disk path. `read(id)` reads `<rootPath>/<id>.md` as
 * UTF-8 text. Both surfaces use the same `id` shape so the spec example
 * round-trips: `for (const file of mirror.list(...)) await mirror.read(file.id)`.
 *
 * Disposal is currently a no-op. We keep the protocol entry point so the
 * shape stays symmetric with `attachSqliteMirror` and so we have somewhere
 * to hang a future `chokidar` watcher's teardown without changing the
 * call shape.
 */

import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';

/**
 * Options for {@link attachMarkdownMirror}.
 */
export type AttachMarkdownMirrorOptions = {
	/**
	 * Absolute path to the daemon's markdown tree root. Typically
	 * `markdownPath(absDir, ydoc.guid)`.
	 */
	rootPath: string;
};

/**
 * One file entry yielded by {@link MarkdownMirrorAttachment.list}.
 */
export type MarkdownFileEntry = {
	/** Path relative to `rootPath` minus the `.md` suffix. POSIX separators. */
	id: string;
	/** Absolute on-disk path. */
	path: string;
};

/**
 * Optional filter for {@link MarkdownMirrorAttachment.list}.
 */
export type MarkdownListOptions = {
	/**
	 * Restrict iteration to files whose `id` starts with this prefix.
	 * POSIX-style: pass `'entries/'` to walk only `<rootPath>/entries/**`.
	 * Trailing slash is optional.
	 */
	prefix?: string;
};

/**
 * Read-only handle returned by {@link attachMarkdownMirror}.
 */
export type MarkdownMirrorAttachment = {
	/** Absolute path to the markdown tree root the mirror was opened on. */
	readonly rootPath: string;
	/**
	 * Walk the markdown tree, yielding one `{ id, path }` entry per `.md`
	 * file. Optionally restrict to a `prefix` (a subdirectory of `rootPath`).
	 */
	list(options?: MarkdownListOptions): AsyncIterable<MarkdownFileEntry>;
	/**
	 * Read a single markdown file as UTF-8 text. `id` is the same shape
	 * yielded by `list` (relative path minus `.md`, POSIX separators).
	 */
	read(id: string): Promise<string>;
	/** Currently a no-op; reserved for future watcher teardown. */
	[Symbol.dispose](): void;
};

/**
 * Open a read-only handle on the daemon's markdown tree.
 *
 * Does no I/O at construction time; the first listing or read may throw
 * `ENOENT` if the daemon has not produced the tree yet. Callers that need
 * to gate on tree existence can stat `rootPath` themselves.
 *
 * @example
 * ```ts
 * using mirror = attachMarkdownMirror({
 *   rootPath: markdownPath(absDir, fuji.ydoc.guid),
 * });
 * for await (const file of mirror.list({ prefix: 'entries/' })) {
 *   const body = await mirror.read(file.id);
 *   console.log(file.id, body.length);
 * }
 * ```
 */
export function attachMarkdownMirror({
	rootPath,
}: AttachMarkdownMirrorOptions): MarkdownMirrorAttachment {
	let isDisposed = false;

	async function* list(
		options: MarkdownListOptions = {},
	): AsyncIterable<MarkdownFileEntry> {
		if (isDisposed) return;
		const prefix = options.prefix ?? '';
		const start = prefix ? join(rootPath, prefix) : rootPath;
		yield* walkMarkdownFiles(rootPath, start);
	}

	async function read(id: string): Promise<string> {
		// `id` carries POSIX separators by contract; translate back to the
		// platform separator before joining, but reject any `..` segment
		// to keep the read confined to `rootPath`.
		if (id.split(/[/\\]/).some((segment) => segment === '..')) {
			throw new Error(
				`attachMarkdownMirror.read: id "${id}" contains a parent traversal segment.`,
			);
		}
		const relativePath = id.split(posix.sep).join(sep);
		const filePath = join(rootPath, `${relativePath}.md`);
		return readFile(filePath, 'utf-8');
	}

	function dispose() {
		isDisposed = true;
	}

	return {
		rootPath,
		list,
		read,
		[Symbol.dispose]: dispose,
	};
}

/**
 * Recursively walk `directory`, yielding one entry per `.md` file. Each
 * entry's `id` is computed against `rootPath` so the same id the caller
 * yielded comes back to `read()` and resolves correctly.
 *
 * Directory-not-found is treated as "no files here" (the daemon may not
 * have written the tree yet); other errors propagate.
 */
async function* walkMarkdownFiles(
	rootPath: string,
	directory: string,
): AsyncIterable<MarkdownFileEntry> {
	let entries: Dirent[];
	try {
		entries = (await readdir(directory, { withFileTypes: true })) as Dirent[];
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
		throw error;
	}
	// Stable ordering helps tests assert deterministic iteration without
	// reaching for sort comparators at every call site.
	entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const entry of entries) {
		const childPath = join(directory, entry.name);
		if (entry.isDirectory()) {
			yield* walkMarkdownFiles(rootPath, childPath);
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
		const idPath = relative(rootPath, childPath).split(sep).join(posix.sep);
		const id = idPath.slice(0, -'.md'.length);
		yield { id, path: childPath };
	}
}
