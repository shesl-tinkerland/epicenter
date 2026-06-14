import { Type } from 'typebox';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
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
// The engine carries NO filesystem or YAML runtime of its own: both the
// `MarkdownExportFs` and the `assemble` serializer are injected. That keeps this
// module free of any `node:*` or `bun` import, so it loads in a Tauri webview
// (with a `@tauri-apps/plugin-fs` adapter) exactly as it does in the daemon (with
// the node adapter). All path *policy* lives here (confinement, table scoping);
// the adapter owns path *mechanics* (joining the "/"-relative path onto the base
// directory with the platform separator) and the actual reads and writes.
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

/**
 * Serialize frontmatter + an optional body into a markdown file's contents.
 * Injected so the engine carries no YAML runtime: the daemon passes the
 * `Bun.YAML`-backed `assembleMarkdown`; a webview passes a browser-safe one.
 */
export type AssembleMarkdown = (
	frontmatter: Record<string, unknown>,
	body: string | undefined,
) => string;

/**
 * The filesystem surface the markdown export writes through. Every `relPath` is a
 * validated, "/"-separated path relative to `baseDir` with no `.`/`..` segment and
 * no leading separator; the adapter translates "/" to the platform separator (and
 * `listFiles` translates back). Keeping the surface to these few verbs lets one
 * `node:fs`/`bun` adapter serve the daemon and a `@tauri-apps/plugin-fs` adapter
 * serve the desktop app, with the confinement policy living in the engine, not
 * duplicated per adapter.
 */
export interface MarkdownExportFs {
	/** `mkdir -p` of `baseDir`, or of `baseDir/subDir` when `subDir` is given. */
	ensureDir(baseDir: string, subDir?: string): Promise<void>;
	/**
	 * Write `content` at `baseDir/relPath`, creating any intermediate directories
	 * the relPath implies (e.g. `archive/old.md`).
	 */
	writeFile(baseDir: string, relPath: string, content: string): Promise<void>;
	/**
	 * Remove `baseDir/relPath`. MUST resolve (not reject) when the file is already
	 * gone; the engine treats deletes as best-effort.
	 */
	removeFile(baseDir: string, relPath: string): Promise<void>;
	/**
	 * Every file under `baseDir`, recursively, as "/"-relative paths. Resolves to
	 * `[]` when `baseDir` does not exist. Drives the destructive rebuild's sweep.
	 */
	listFiles(baseDir: string): Promise<string[]>;
	/**
	 * Optional bulk write for the cold-start flush. Adapters that can batch (a
	 * single Tauri invoke, `Bun.write`) implement it; the engine falls back to
	 * looping `writeFile` when it is absent. Only ever called with a fresh,
	 * rename-free set (the initial flush), so it carries no ordering obligation.
	 */
	writeFiles?(
		baseDir: string,
		files: ReadonlyArray<{ relPath: string; content: string }>,
	): Promise<void>;
}

/** Per-table customization for the read-only export. Every field is optional. */
export type ExportTableConfig<TRow extends BaseRow> = {
	/** Subdirectory (joined onto the base `dir`) for this table. Default: `table.name`. Pass `''` or `'.'` to write into the base dir directly. */
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
		fs,
		assemble,
		tables: tablesConfig,
		waitFor,
		disposeTimeoutMs = 10_000,
		log = createLogger('markdown-export'),
	}: {
		/** Base output directory. A string or async getter for lazy path resolution. */
		dir: string | (() => MaybePromise<string>);
		/** Filesystem adapter (node/bun or Tauri). The engine carries none of its own. */
		fs: MarkdownExportFs;
		/** Frontmatter + body serializer. The engine carries no YAML runtime of its own. */
		assemble: AssembleMarkdown;
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
				content: assemble(shape.frontmatter, shape.body),
			};
		};
		// Normalize the table's subdirectory: `''`/`'.'` mean "the base dir
		// itself". A non-empty subdir is validated lazily, at flush time, so a bad
		// `config.dir` surfaces through `whenFlushed` rather than throwing from this
		// constructor.
		const rawSubdir = config.dir ?? name;
		const subdir = rawSubdir === '' || rawSubdir === '.' ? '' : rawSubdir;
		registered.set(name, {
			table: anyTable,
			config,
			fileState: new Map(),
			render,
			subdir,
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
		await fs.ensureDir(baseDir);

		for (const entry of registered.values()) {
			const unsubscribe = await materializeTable({
				fs,
				baseDir,
				subdir: entry.subdir,
				table: entry.table,
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
				fs,
				baseDir,
				subdir: entry.subdir,
				table: entry.table,
				render: entry.render,
				fileState: entry.fileState,
				log,
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
// `RenderRow`; everything below is the generic write loop the export drives,
// through the injected `MarkdownExportFs`.
// ════════════════════════════════════════════════════════════════════════════

/** Render a row to its on-disk artifact: the export's injected serialization. */
type RenderRow = (
	row: BaseRow,
) => Promise<{ filename: string; content: string }>;

/**
 * What materialize last wrote for a row, keyed by id. Drives rename cleanup:
 * when a row's filename changes, remove the previous file before writing the new
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
	/**
	 * A `scan()` over a table surfaced entries that will not materialize: rows
	 * the binary cannot parse, rows from a newer writer, or undecryptable rows.
	 * The export projects only `scan().rows`; this records what it skipped so the
	 * gap is in the log rather than silent.
	 */
	NonconformingRowsSkipped: ({
		tableName,
		nonconforming,
		newerWriter,
		unreadable,
	}: {
		tableName: string;
		nonconforming: number;
		newerWriter: number;
		unreadable: number;
	}) => ({
		message: `[markdown] "${tableName}" skipped rows that did not materialize: ${nonconforming} nonconforming, ${newerWriter} from a newer writer, ${unreadable} unreadable`,
		tableName,
		nonconforming,
		newerWriter,
		unreadable,
	}),
});

/**
 * Validate a "/"-relative export path, the confinement boundary the export
 * relies on now that the namespace root, not a hardcoded `apps/` segment, is the
 * ownership claim. Rejects absolute paths (a leading separator or a Windows drive
 * letter) and any `.`, `..`, or empty segment, so a `render` that returns
 * `../../notes/x.md`, an absolute path, or a table `dir` of `..` can never resolve
 * outside the export root (spec invariants 7 and 9). Both separators are checked
 * defensively in case a renderer emits `\`.
 *
 * Returns the "/"-normalized path so the adapter always receives one separator
 * flavor. Throws a plain `Error` (not a `defineErrors` variant): these propagate
 * through the same throw/catch path as the rest of the write code, and a
 * `defineErrors` value is an `Err` Result meant for logging or returning, never
 * for `throw`.
 */
function assertSafeRelPath(relPath: string): string {
	const normalized = relPath.replace(/\\/g, '/');
	const segments = normalized.split('/');
	const escapes =
		normalized === '' ||
		normalized.startsWith('/') ||
		/^[A-Za-z]:/.test(normalized) ||
		segments.some((s) => s === '' || s === '.' || s === '..');
	if (escapes) {
		throw new Error(
			`[markdown] refusing path "${relPath}": it resolves outside the export root`,
		);
	}
	return normalized;
}

/**
 * Compose a table's subdirectory and a row's rendered filename into one validated
 * "/"-relative path. The filename may itself contain subdirectories (e.g.
 * `archive/old.md`); the whole composed path is validated, so an escaping filename
 * is rejected before any byte is written.
 */
function joinRel(subdir: string, filename: string): string {
	return assertSafeRelPath(subdir ? `${subdir}/${filename}` : filename);
}

/**
 * Log the issue buckets a `scan()` surfaced, if any. The markdown export only
 * writes `scan().rows`; this makes the skipped buckets visible instead of a
 * silent drop.
 */
function logSkippedRows(
	log: Logger,
	tableName: string,
	scan: {
		nonconforming: readonly unknown[];
		newerWriter: readonly unknown[];
		unreadable: readonly unknown[];
	},
): void {
	if (
		scan.nonconforming.length === 0 &&
		scan.newerWriter.length === 0 &&
		scan.unreadable.length === 0
	) {
		return;
	}
	log.warn(
		MaterializerWriteError.NonconformingRowsSkipped({
			tableName,
			nonconforming: scan.nonconforming.length,
			newerWriter: scan.newerWriter.length,
			unreadable: scan.unreadable.length,
		}),
	);
}

/**
 * Best-effort remove of an already-confined `relPath` under `baseDir`; a missing
 * file or a failed remove is ignored. The caller composes `relPath` through
 * `joinRel` first, so an escaping previous filename throws there (before this
 * best-effort catch): an escaping delete is a bug, not a routine miss.
 */
async function tryRemove(
	fs: MarkdownExportFs,
	baseDir: string,
	relPath: string,
): Promise<void> {
	try {
		await fs.removeFile(baseDir, relPath);
	} catch {
		// already gone, or the remove failed; nothing to do
	}
}

/**
 * Continuously materialize one table under `baseDir/subdir`: an initial flush of
 * every valid row, then an observe that rewrites a row's file on change and
 * removes it when the row goes invalid or is deleted. Returns the observer
 * unsubscribe.
 *
 * Only CONTENT PRODUCTION is guarded: a throwing `render` (e.g. a body read
 * hitting its connect deadline) skips that one row and leaves its existing `.md`
 * intact, instead of aborting the rest of the flush or the observe batch. A real
 * filesystem write failure (ENOSPC, EACCES) is NOT swallowed: it propagates, so
 * the initial flush rejects and the observer's outer catch surfaces it.
 */
async function materializeTable(opts: {
	fs: MarkdownExportFs;
	baseDir: string;
	subdir: string;
	table: AnyTable;
	render: RenderRow;
	fileState: FileState;
	/** Register an observer batch with the attachment's teardown drain. */
	track: (work: Promise<void>) => void;
	log: Logger;
}): Promise<() => void> {
	const { fs, baseDir, subdir, table, render, fileState, track, log } = opts;

	// Validate the table's subdir here (not at registration) so an escaping
	// `config.dir` rejects through `whenFlushed` instead of throwing from the
	// constructor, and never reaches `ensureDir` to create a directory outside
	// the export root.
	if (subdir) assertSafeRelPath(subdir);
	await fs.ensureDir(baseDir, subdir || undefined);

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
			await tryRemove(fs, baseDir, joinRel(subdir, previous.filename));
		}
		await fs.writeFile(baseDir, joinRel(subdir, filename), content);
		fileState.set(id, { filename, content });
	}

	const initialScan = table.scan();
	logSkippedRows(log, table.name, initialScan);

	// Cold-start flush. `fileState` is empty, so there are no renames to sequence:
	// when the adapter can batch, render the whole set and hand it over in one call
	// (one Tauri invoke instead of N), else fall back to the per-row path.
	if (fs.writeFiles && initialScan.rows.length > 0) {
		const batch: { id: string; filename: string; content: string }[] = [];
		for (const row of initialScan.rows) {
			try {
				const rendered = await render(row);
				batch.push({ id: row.id, ...rendered });
			} catch (cause) {
				log.warn(
					MaterializerWriteError.TableWriteFailed({
						tableName: table.name,
						id: row.id,
						cause,
					}),
				);
			}
		}
		await fs.writeFiles(
			baseDir,
			batch.map((b) => ({
				relPath: joinRel(subdir, b.filename),
				content: b.content,
			})),
		);
		for (const b of batch) {
			fileState.set(b.id, { filename: b.filename, content: b.content });
		}
	} else {
		for (const row of initialScan.rows) {
			await writeRow(row.id, row);
		}
	}

	// Sequential writes inside the observer avoid rename races; a parallel
	// approach (Promise.allSettled) could delete a file another write needs.
	return table.observe((changedIds) => {
		const batch = (async () => {
			for (const id of changedIds) {
				const { data: row, error } = table.get(id);

				// Invalid or missing → remove any previously-written file.
				if (error || row === null) {
					const previous = fileState.get(id);
					if (previous) {
						await tryRemove(fs, baseDir, joinRel(subdir, previous.filename));
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
 * Destructive re-export of one table under `baseDir/subdir`: render every valid
 * row BEFORE touching disk (a throwing render aborts the rebuild with the existing
 * files intact, rather than deleting everything and then failing to rewrite), then
 * sweep the existing `.md` files in this table's subtree and write the rendered
 * set. Updates `fileState` so the live observer stays consistent.
 */
async function rebuildTable(opts: {
	fs: MarkdownExportFs;
	baseDir: string;
	subdir: string;
	table: AnyTable;
	render: RenderRow;
	fileState: FileState;
	log: Logger;
}): Promise<{ deleted: number; written: number }> {
	const { fs, baseDir, subdir, table, render, fileState, log } = opts;
	let deleted = 0;
	let written = 0;

	// Confine the subdir before any sweep or write, so a rebuild of an
	// escaping-`dir` table cannot delete or create outside the export root.
	if (subdir) assertSafeRelPath(subdir);

	const scan = table.scan();
	logSkippedRows(log, table.name, scan);
	const rendered: { id: string; filename: string; content: string }[] = [];
	for (const row of scan.rows) {
		const r = await render(row);
		rendered.push({ id: row.id, filename: r.filename, content: r.content });
	}

	// Sweep existing `.md` files in this table's subtree. `listFiles` returns
	// "/"-relative paths under `baseDir`; scope to this table by its subdir prefix
	// (empty subdir = the base dir, so every file is in scope, matching the old
	// per-table-directory readdir). An entry that fails confinement (a symlink
	// resolving out of the projection) is skipped, not removed (spec invariant 9).
	const prefix = subdir ? `${subdir}/` : '';
	for (const rel of await fs.listFiles(baseDir)) {
		if (!rel.endsWith('.md')) continue;
		if (prefix && !rel.startsWith(prefix)) continue;
		let safe: string;
		try {
			safe = assertSafeRelPath(rel);
		} catch {
			continue;
		}
		try {
			await fs.removeFile(baseDir, safe);
			deleted++;
		} catch {
			// best-effort: a file that vanished or failed to remove is not fatal
		}
	}

	fileState.clear();
	await fs.ensureDir(baseDir, subdir || undefined);
	for (const { id, filename, content } of rendered) {
		await fs.writeFile(baseDir, joinRel(subdir, filename), content);
		fileState.set(id, { filename, content });
		written++;
	}

	return { deleted, written };
}
