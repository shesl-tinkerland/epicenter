import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Type } from 'typebox';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { assembleMarkdown } from '../../../markdown/assemble-markdown.js';
import { defineActions, defineMutation } from '../../../shared/actions.js';
import type { MaybePromise } from '../../../shared/types.js';
import type { BaseRow, Table } from '../../table.js';
import {
	type AnyTable,
	type MaterializerInput,
	settledWithin,
	type TablesRecord,
} from '../shared.js';

// ════════════════════════════════════════════════════════════════════════════
// attachMarkdownExport: the read-only markdown projection
//
// A continuously-materialized, ONE-WAY Yjs → disk view with free serialization:
// custom filenames (slugs), custom `toMarkdown` (layouts, publish transforms),
// per-table subdirectories. There is no `apply`: this projection is never read
// back, so it carries no round-trip obligation and can shape the output however a
// human-readable export or a published site wants. Mutating app data goes through
// validated actions instead, never by editing the materialized `.md`. The sqlite
// materializer is the read-only sibling for a relational projection.
//
// The observe/flush/rebuild machinery (materializeTable, rebuildTable) lives at
// the bottom of this file: it was a shared substrate back when an editable vault
// seam also consumed it; with that seam deleted, this export is its only caller,
// so it is no longer a separate module.
// ════════════════════════════════════════════════════════════════════════════

/** Frontmatter + optional body, the assembled shape of a `.md` file. */
export type MarkdownShape = {
	frontmatter: Record<string, unknown>;
	body: string | undefined;
};

/** Per-table customization for the read-only export. Every field is optional. */
export type ExportTableConfig<TRow extends BaseRow> = {
	/** Subdirectory (joined onto the base `dir`) for this table. Default: `table.name`. */
	dir?: string;
	/** Compute the on-disk filename for a row. Default: `${row.id}.md`. */
	filename?: (row: TRow) => MaybePromise<string>;
	/** Produce frontmatter + body for a row. Default: `{ frontmatter: row, body: undefined }`. */
	toMarkdown?: (row: TRow) => MaybePromise<MarkdownShape>;
};

/**
 * Mapped per-table config keyed by `workspace.tables` name. Presence is the
 * selection: only tables named here are exported.
 */
export type ExportTablesConfig<TTableHandles extends TablesRecord> = {
	[K in keyof TTableHandles]?: TTableHandles[K] extends Table<infer TRow>
		? ExportTableConfig<TRow>
		: never;
};

type RegisteredTable = {
	table: AnyTable;
	// biome-ignore lint/suspicious/noExplicitAny: internal storage, variance across heterogeneous row types
	config: ExportTableConfig<any>;
	fileState: FileState;
	render: RenderRow;
	subdir: string;
	unsubscribe?: () => void;
};

/**
 * Attach a read-only markdown export to a workspace. Continuously materializes
 * the selected tables to disk with caller-controlled serialization, and exposes
 * a single `markdown_rebuild` mutation for a destructive full re-export (orphan
 * cleanup after a filename/layout change). There is no import path.
 */
export function attachMarkdownExport<TTableHandles extends TablesRecord>(
	workspace: MaterializerInput<TTableHandles>,
	{
		dir,
		tables: tablesConfig,
		waitFor,
		disposeTimeoutMs = 10_000,
		log = createLogger('markdown-export'),
	}: {
		/** Base output directory. A string or async getter for lazy path resolution. */
		dir: string | (() => MaybePromise<string>);
		/**
		 * Per-table customization keyed by `workspace.tables` name. Presence selects:
		 * only tables named here are exported. Pass `{}` for an entry to export with
		 * all defaults.
		 */
		tables?: ExportTablesConfig<TTableHandles>;
		/** Gate: awaited before the initial filesystem flush. Omit for no gate. */
		waitFor?: Promise<unknown>;
		/**
		 * Upper bound on the teardown drain: dispose waits at most this long for
		 * the initial flush and in-flight row renders to settle before resolving
		 * `whenDisposed`, so a hung render (e.g. a stuck HTTP body read) cannot
		 * wedge shutdown. Defaults to 10 seconds.
		 */
		disposeTimeoutMs?: number;
		/** Logger for background write-observer failures. */
		log?: Logger;
	},
) {
	const { ydoc, tables } = workspace;
	const registered = new Map<string, RegisteredTable>();
	for (const [name, table] of Object.entries(tables)) {
		const config = (
			tablesConfig as Record<string, ExportTableConfig<BaseRow>> | undefined
		)?.[name];
		if (config === undefined) continue;
		const anyTable = table as AnyTable;
		const render: RenderRow = async (row) => {
			const shape = config.toMarkdown
				? await config.toMarkdown(row)
				: { frontmatter: { ...row }, body: undefined };
			const filename = config.filename
				? await config.filename(row)
				: `${row.id}.md`;
			return {
				filename,
				content: assembleMarkdown(shape.frontmatter, shape.body),
			};
		};
		registered.set(name, {
			table: anyTable,
			config,
			fileState: new Map(),
			render,
			subdir: config.dir ?? name,
		});
	}
	let isDisposed = false;
	// The `waitFor` gate has resolved, so the initial flush is underway (or
	// done) and teardown owes it a drain. Disposing while the gate is still
	// closed owes nothing: the flush never started, and `initialize` bails
	// when the gate finally opens.
	let isGateOpen = waitFor === undefined;
	let isFlushAbandoned = false;

	// In-flight observer render batches. Each batch is added when its observer
	// fires and removed when it settles, so the teardown drain can await
	// exactly the writes that were mid-flight at dispose time.
	const pendingWrites = new Set<Promise<void>>();
	function trackPendingWrite(work: Promise<void>) {
		pendingWrites.add(work);
		void work.finally(() => pendingWrites.delete(work));
	}

	const resolveDir = async () =>
		typeof dir === 'function' ? await dir() : dir;

	const { promise: whenDisposed, resolve: resolveDisposed } =
		Promise.withResolvers<void>();

	function dispose() {
		if (isDisposed) return;
		isDisposed = true;
		isFlushAbandoned = !isGateOpen;
		for (const entry of registered.values()) entry.unsubscribe?.();
		void drainPendingWork().finally(resolveDisposed);
	}

	/**
	 * Drain projection work still in flight at dispose: the initial flush
	 * (unless its gate never opened) and any observer render batches. Bounded
	 * by `disposeTimeoutMs` so teardown cannot wedge on a hung render.
	 */
	async function drainPendingWork() {
		const pending: Promise<unknown>[] = isFlushAbandoned
			? [...pendingWrites]
			: [whenFlushed, ...pendingWrites];
		if (pending.length === 0) return;
		const didSettle = await settledWithin(
			Promise.allSettled(pending),
			disposeTimeoutMs,
		);
		if (!didSettle) {
			log.warn(
				MaterializerWriteError.DrainTimedOut({ timeoutMs: disposeTimeoutMs }),
			);
		}
	}

	ydoc.once('destroy', dispose);

	async function initialize() {
		await waitFor;
		isGateOpen = true;
		if (isFlushAbandoned) return;

		const baseDir = await resolveDir();
		await mkdir(baseDir, { recursive: true });

		for (const entry of registered.values()) {
			const unsubscribe = await materializeTable({
				table: entry.table,
				directory: join(baseDir, entry.subdir),
				render: entry.render,
				fileState: entry.fileState,
				track: trackPendingWrite,
				log,
			});
			// Disposed mid-flush: the writes above are owed (the teardown drain
			// awaits this whole flush), but no observer may outlive teardown.
			if (isDisposed) unsubscribe();
			else entry.unsubscribe = unsubscribe;
		}
	}

	const whenFlushed = initialize();

	async function rebuildMarkdownFiles(
		tableName?: string,
	): Promise<{ deleted: number; written: number }> {
		const baseDir = await resolveDir();

		async function rebuildOne(entry: RegisteredTable) {
			return rebuildTable({
				table: entry.table,
				directory: join(baseDir, entry.subdir),
				render: entry.render,
				fileState: entry.fileState,
			});
		}

		if (tableName !== undefined) {
			const entry = registered.get(tableName);
			if (entry === undefined) {
				throw new Error(
					`Cannot rebuild "${tableName}": not in the export's table set.`,
				);
			}
			return rebuildOne(entry);
		}

		let deleted = 0;
		let written = 0;
		for (const entry of registered.values()) {
			const r = await rebuildOne(entry);
			deleted += r.deleted;
			written += r.written;
		}
		return { deleted, written };
	}

	return {
		whenFlushed,
		/**
		 * Resolves after `ydoc.destroy()` once pending projection work (the
		 * initial flush and in-flight row renders) has drained, bounded by
		 * `disposeTimeoutMs`. Daemon teardown awaits this before process exit
		 * so a shutdown cannot drop markdown writes mid-flight.
		 */
		whenDisposed,
		actions: defineActions({
			markdown_rebuild: defineMutation({
				title: 'Rebuild Markdown Export',
				description:
					'Destructive: delete existing .md files in registered table directories and re-serialize all valid rows. Optionally limit to one table.',
				input: Type.Object({
					tableName: Type.Optional(
						Type.String({
							description:
								'Limit rebuild to one registered table; omit for all tables.',
						}),
					),
				}),
				handler: ({ tableName }) => rebuildMarkdownFiles(tableName),
			}),
		}),
	};
}

export type MarkdownExport = ReturnType<typeof attachMarkdownExport>;

// ════════════════════════════════════════════════════════════════════════════
// Materialize machinery: Yjs -> disk observe/flush/rebuild
//
// HOW a row renders to a file (custom filename + serialization) is injected as a
// `RenderRow`; everything below is the generic write loop the export drives.
// ════════════════════════════════════════════════════════════════════════════

/** Render a row to its on-disk artifact: the export's injected serialization. */
type RenderRow = (
	row: BaseRow,
) => Promise<{ filename: string; content: string }>;

/**
 * What materialize last wrote for a row, keyed by id. Drives rename cleanup:
 * when a row's filename changes, unlink the previous file before writing the new
 * one so a rename does not leave an orphan behind.
 */
type FileState = Map<string, { filename: string; content: string }>;

/**
 * Errors produced by the background write-observer (table row → .md file) and
 * the teardown drain. These run inside `.catch(...)` of a detached async task,
 * so they ship to the logger, not through a Result to the caller.
 */
const MaterializerWriteError = defineErrors({
	TableWriteFailed: ({
		tableName,
		id,
		cause,
	}: {
		tableName: string;
		id?: string;
		cause: unknown;
	}) => ({
		message: `[markdown] table write failed for "${tableName}"${id ? ` (row "${id}")` : ''}: ${extractErrorMessage(cause)}`,
		tableName,
		id,
		cause,
	}),
	DrainTimedOut: ({ timeoutMs }: { timeoutMs: number }) => ({
		message: `[markdown] teardown drain did not settle within ${timeoutMs}ms; abandoning pending writes`,
		timeoutMs,
	}),
});

/** Best-effort unlink; a missing file or a failed remove is ignored. */
async function tryUnlink(directory: string, filename: string): Promise<void> {
	try {
		await unlink(join(directory, filename));
	} catch {
		// already gone, or the remove failed; nothing to do
	}
}

/**
 * Write a markdown file under `directory`, creating any intermediate
 * subdirectories implied by a filename like `"archive/old.md"`.
 */
async function writeMarkdownFile(
	directory: string,
	filename: string,
	content: string,
): Promise<void> {
	const fullPath = join(directory, filename);
	const parent = dirname(fullPath);
	if (parent !== directory) {
		await mkdir(parent, { recursive: true });
	}
	await writeFile(fullPath, content);
}

/**
 * Continuously materialize one table to `directory`: an initial flush of every
 * valid row, then an observe that rewrites a row's file on change and unlinks it
 * when the row goes invalid or is deleted. Returns the observer unsubscribe.
 *
 * Only CONTENT PRODUCTION is guarded: a throwing `render` (e.g. a body read
 * hitting its connect deadline) skips that one row and leaves its existing `.md`
 * intact, instead of aborting the rest of the flush or the observe batch. A real
 * filesystem write failure (ENOSPC, EACCES) is NOT swallowed: it propagates, so
 * the initial flush rejects and the observer's outer catch surfaces it.
 */
async function materializeTable(opts: {
	table: AnyTable;
	directory: string;
	render: RenderRow;
	fileState: FileState;
	/** Register an observer batch with the attachment's teardown drain. */
	track: (work: Promise<void>) => void;
	log: Logger;
}): Promise<() => void> {
	const { table, directory, render, fileState, track, log } = opts;

	await mkdir(directory, { recursive: true });

	// Write one valid row to disk, shared by the initial flush and the observer.
	// The rename branch is a no-op on first write (`fileState` starts empty), so
	// both paths run this exact code.
	async function writeRow(id: string, row: BaseRow): Promise<void> {
		let rendered: { filename: string; content: string };
		try {
			rendered = await render(row);
		} catch (cause) {
			log.warn(
				MaterializerWriteError.TableWriteFailed({
					tableName: table.name,
					id,
					cause,
				}),
			);
			return;
		}
		const { filename, content } = rendered;
		const previous = fileState.get(id);
		if (previous && previous.filename !== filename) {
			await tryUnlink(directory, previous.filename);
		}
		await writeMarkdownFile(directory, filename, content);
		fileState.set(id, { filename, content });
	}

	for (const row of table.getAllValid()) {
		await writeRow(row.id, row);
	}

	// Sequential writes inside the observer avoid rename races; a parallel
	// approach (Promise.allSettled) could delete a file another write needs.
	return table.observe((changedIds) => {
		const batch = (async () => {
			for (const id of changedIds) {
				const { data: row, error } = table.get(id);

				// Invalid or missing → unlink any previously-written file.
				if (error || row === null) {
					const previous = fileState.get(id);
					if (previous) {
						await tryUnlink(directory, previous.filename);
						fileState.delete(id);
					}
					continue;
				}

				await writeRow(id, row);
			}
		})().catch((cause) => {
			// Reached only by a genuine failure `writeRow` does not swallow: a
			// filesystem write error, or an unexpected throw in the loop scaffolding.
			log.warn(
				MaterializerWriteError.TableWriteFailed({
					tableName: table.name,
					cause,
				}),
			);
		});
		track(batch);
	});
}

/**
 * Destructive re-export of one table to `directory`: render every valid row
 * BEFORE touching disk (a throwing render aborts the rebuild with the existing
 * files intact, rather than deleting everything and then failing to rewrite),
 * then sweep existing `.md` files and write the rendered set. Updates `fileState`
 * so the live observer stays consistent.
 */
async function rebuildTable(opts: {
	table: AnyTable;
	directory: string;
	render: RenderRow;
	fileState: FileState;
}): Promise<{ deleted: number; written: number }> {
	const { table, directory, render, fileState } = opts;
	let deleted = 0;
	let written = 0;

	const rendered: { id: string; filename: string; content: string }[] = [];
	for (const row of table.getAllValid()) {
		const r = await render(row);
		rendered.push({ id: row.id, filename: r.filename, content: r.content });
	}

	try {
		const files = await readdir(directory, { recursive: true });
		for (const filename of files) {
			if (!filename.endsWith('.md')) continue;
			const path = join(directory, filename);
			await unlink(path).then(
				() => {
					deleted++;
				},
				() => undefined,
			);
		}
	} catch {
		// Directory doesn't exist yet. Fine.
	}

	fileState.clear();
	await mkdir(directory, { recursive: true });
	for (const { id, filename, content } of rendered) {
		await writeMarkdownFile(directory, filename, content);
		fileState.set(id, { filename, content });
		written++;
	}

	return { deleted, written };
}
