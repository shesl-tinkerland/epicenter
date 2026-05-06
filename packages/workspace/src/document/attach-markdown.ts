import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import Type from 'typebox';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { tryAsync } from 'wellcrafted/result';
import type * as Y from 'yjs';
import { defineMutation } from '../shared/actions.js';
import { createLogger, type Logger } from 'wellcrafted/logger';
import type { MaybePromise } from '../shared/types.js';
import type { Kv } from './attach-kv.js';
import {
	type BaseRow,
	type Table,
	type TableParseError,
} from './attach-table.js';
import type { SerializeResult } from './markdown/markdown.js';
import { assembleMarkdown } from './markdown/markdown.js';
import { parseMarkdownFile } from './markdown/parse-markdown-file.js';

// Re-exports kept narrow to what current consumers actually pull through
// the `@epicenter/workspace/document/attach-markdown` subpath. `SerializeResult`
// and `toIdFilename` were dropped (no external consumers); internal modules
// still import them directly from `./markdown/*`.
export { assembleMarkdown } from './markdown/markdown.js';
export { parseMarkdownFile } from './markdown/parse-markdown-file.js';
export { prepareMarkdownFiles } from './markdown/prepare-markdown-files.js';
export { slugFilename, toSlugFilename } from './markdown/serializers.js';

// ════════════════════════════════════════════════════════════════════════════
// PUSH ERROR + EVENT TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * Errors produced by the background write-observer (table row → .md file,
 * KV state → serialized file). These run inside `.catch(...)` of a detached
 * async task, so they ship to the logger, not through a Result to the caller.
 */
export const AttachMarkdownWriteError = defineErrors({
	TableWriteFailed: ({
		tableName,
		cause,
	}: {
		tableName: string;
		cause: unknown;
	}) => ({
		message: `[attachMarkdown] table write failed for "${tableName}": ${extractErrorMessage(cause)}`,
		tableName,
		cause,
	}),
	KvWriteFailed: ({ cause }: { cause: unknown }) => ({
		message: `[attachMarkdown] kv write failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type AttachMarkdownWriteError = InferErrors<
	typeof AttachMarkdownWriteError
>;

/**
 * Errors produced during `push` that aren't already covered by
 * `TableParseError`. Filename / tableName provenance lives on the
 * emitted `PushEvent`, not inside the error: the error knows its
 * layer, the event carries external context.
 */
export const AttachMarkdownPushError = defineErrors({
	/** Reading the file from disk failed. */
	ReadFailed: ({ cause }: { cause: unknown }) => ({
		message: `Read failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/** The caller-supplied `fromMarkdown` callback threw. */
	FromMarkdownCallbackFailed: ({ cause }: { cause: unknown }) => ({
		message: `fromMarkdown callback threw: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type AttachMarkdownPushError = InferErrors<
	typeof AttachMarkdownPushError
>;

/**
 * A single event emitted during `push`. Three kinds:
 *
 * - **`imported`**: the file was read, parsed, validated, and its row set.
 * - **`skipped`**: the file couldn't be parsed as markdown-with-frontmatter
 *   (no `---` delimiters, empty delimiters, or frontmatter that doesn't
 *   decode to an object). The three cases collapse at the parser boundary
 *   into a single "not a note" decision: no discriminator needed.
 * - **`error`**: something failed. `error.name` discriminates between
 *   `ReadFailed` / `FromMarkdownCallbackFailed` (materializer errors) and
 *   `ValidationFailed` / `MigrationFailed` / `AsyncSchemaNotSupported`
 *   (table parse errors).
 *
 * `path` is the relative path from the materializer's base `dir` (e.g.,
 * `"posts/hello.md"` for a file under `config.dir: 'posts'`). Not the
 * bare filename: two tables writing the same filename would be
 * indistinguishable otherwise.
 */
export type PushEvent =
	| { kind: 'imported'; path: string; tableName: string; id: string }
	| { kind: 'skipped'; path: string }
	| {
			kind: 'error';
			path: string;
			tableName: string;
			error: AttachMarkdownPushError | TableParseError;
	  };

/** Aggregated result of one `push` invocation. */
export type PushResult = {
	imported: number;
	skipped: number;
	errored: number;
	events: PushEvent[];
};

// biome-ignore lint/suspicious/noExplicitAny: generic bound for heterogeneous kv
type AnyKv = Kv<any>;
// biome-ignore lint/suspicious/noExplicitAny: generic bound for heterogeneous tables
type AnyTable = Table<any>;

/**
 * Symmetric shape of a parsed markdown file. `toMarkdown` produces it,
 * `fromMarkdown` consumes it: `Parameters<fromMarkdown>[0]` ≡ `ReturnType<toMarkdown>`.
 */
export type MarkdownShape = {
	frontmatter: Record<string, unknown>;
	body: string | undefined;
};

type TableConfig<TRow extends BaseRow> = {
	/** Subdirectory (joined onto the base `dir`) for this table's files. Default: `table.name`. */
	dir?: string;
	/** Compute the on-disk filename for a row. Default: `${row.id}.md`. */
	filename?: (row: TRow) => MaybePromise<string>;
	/** Produce frontmatter + body for a row. Default: `{ frontmatter: row, body: undefined }`. */
	toMarkdown?: (row: TRow) => MaybePromise<MarkdownShape>;
	/** Parse frontmatter + body back into a row. Default: `parsed.frontmatter as TRow`. */
	fromMarkdown?: (parsed: MarkdownShape) => MaybePromise<TRow>;
};

type KvConfig = {
	/** Serialize the full KV state to a single file. Default: `kv.json` with JSON.stringify. */
	serialize?: (data: Record<string, unknown>) => SerializeResult;
};

type RegisteredTable = {
	table: AnyTable;
	// biome-ignore lint/suspicious/noExplicitAny: internal storage: variance across heterogeneous row types
	config: TableConfig<any>;
	unsubscribe?: () => void;
};

type RegisteredKv = {
	kv: AnyKv;
	config: KvConfig;
	unsubscribe?: () => void;
};

/** Default filename: `${row.id}.md`. */
const defaultFilename = (row: BaseRow): string => `${row.id}.md`;

/** Default toMarkdown: dump row as frontmatter, no body. */
const defaultToMarkdown = (row: BaseRow): MarkdownShape => ({
	frontmatter: { ...row },
	body: undefined,
});

/** Default fromMarkdown: treat frontmatter as the row. */
const defaultFromMarkdown = (parsed: MarkdownShape): BaseRow =>
	parsed.frontmatter as BaseRow;

/**
 * Default KV serializer: pretty-printed JSON in `kv.json`. Used whenever a
 * registered kv's `config.serialize` isn't provided.
 */
const defaultKvSerialize = (data: Record<string, unknown>): SerializeResult => ({
	filename: 'kv.json',
	content: JSON.stringify(data, null, 2),
});

/**
 * Compose a row into the full on-disk artifact: filename + content string.
 *
 * Resolves the per-slot defaults (`filename`, `toMarkdown`) and runs them
 * through `assembleMarkdown`. Pure except for awaiting caller-supplied promises.
 */
async function rowToMarkdownFile<TRow extends BaseRow>(
	row: TRow,
	config: TableConfig<TRow>,
): Promise<{ filename: string; content: string }> {
	const filenameFn = config.filename ?? defaultFilename;
	const toMarkdownFn = config.toMarkdown ?? defaultToMarkdown;
	const filename = await filenameFn(row);
	const shape = await toMarkdownFn(row);
	const content = assembleMarkdown(shape.frontmatter, shape.body);
	return { filename, content };
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
 * Create a bidirectional markdown materializer for workspace data.
 *
 * `attachMarkdown(ydoc, { dir })` returns a chainable builder where
 * `.table(tableRef, config?)` opts in per table and `.kv(kvRef, config?)` opts
 * in a single KV mirror. Nothing materializes by default.
 *
 * Exposes three mutations:
 * - `push`   : disk → workspace. Import .md files as rows (additive).
 * - `pull`   : workspace → disk. Write every row as .md file (additive).
 * - `rebuild`: workspace → disk, destructive. Clear output dir then rewrite
 *   all rows. Use for orphan cleanup or after config changes.
 *   Matches the sqlite materializer's `rebuild` for cross-materializer parity.
 *
 * Teardown is hooked to the ydoc via `ydoc.once('destroy', ...)`: callers
 * never call a dispose method; destroying the ydoc cascades.
 *
 * @example
 * ```ts
 * const ydoc = new Y.Doc({ guid: 'workspace' });
 * const tables = attachTables(ydoc, myTableDefs);
 * const kv = attachKv(ydoc, myKvDefs);
 * const idb = attachIndexedDb(ydoc);
 *
 * const markdown = attachMarkdown(ydoc, {
 *   dir: './data',
 *   waitFor: idb.whenLoaded,
 * })
 *   .table(tables.posts, {
 *     filename: slugFilename('title'),
 *     // Inline toMarkdown / fromMarkdown callbacks when needed
 *     // most real tables split metadata (on the row) from body
 *     // content (in a separate content-doc via createDisposableCache).
 *   })
 *   .kv(kv);
 * ```
 */
export function attachMarkdown(
	ydoc: Y.Doc,
	{
		dir,
		waitFor,
		log = createLogger('attachMarkdown'),
	}: {
		/** Base output directory. */
		dir: string;
		/**
		 * Gate: the materializer awaits this before the initial filesystem flush.
		 * Matches the `waitFor` convention used by `attachSync`. Omit for no gate.
		 */
		waitFor?: Promise<unknown>;
		/**
		 * Logger for background write-observer failures (table row → file,
		 * KV state → file). Defaults to a console-backed logger.
		 */
		log?: Logger;
	},
) {
	const registered = new Map<string, RegisteredTable>();
	let registeredKv: RegisteredKv | undefined;
	let isDisposed = false;
	/**
	 * Closed once `initialize()` commits (past `await waitFor`). Any `.table()`
	 * / `.kv()` call after this throws: the materializer is past the point
	 * where late registrations would be picked up for initial flush.
	 */
	let isRegistrationOpen = true;

	// ── Per-table materialization ───────────────────────────────

	async function materializeTable(
		baseDir: string,
		{ table, config }: RegisteredTable,
	): Promise<() => void> {
		const directory = join(baseDir, config.dir ?? table.name);
		const filenames = new Map<string, string>();

		await mkdir(directory, { recursive: true });

		for (const row of table.getAllValid()) {
			const { filename, content } = await rowToMarkdownFile(row, config);
			await writeMarkdownFile(directory, filename, content);
			filenames.set(row.id, filename);
		}

		// Sequential writes inside the observer avoid rename races: a parallel
		// approach (Promise.allSettled) could delete a file another write needs.
		return table.observe((changedIds) => {
			void (async () => {
				for (const id of changedIds) {
					const { data: row, error } = table.get(id);

					// Invalid or missing → unlink any previously-written file.
					if (error || row === null) {
						const previous = filenames.get(id);
						if (previous) {
							await unlink(join(directory, previous)).catch(() => {});
							filenames.delete(id);
						}
						continue;
					}

					const { filename, content } = await rowToMarkdownFile(row, config);
					const previous = filenames.get(id);
					if (previous && previous !== filename)
						await unlink(join(directory, previous)).catch(() => {});
					await writeMarkdownFile(directory, filename, content);
					filenames.set(id, filename);
				}
			})().catch((cause) => {
				log.warn(
					AttachMarkdownWriteError.TableWriteFailed({
						tableName: table.name,
						cause,
					}),
				);
			});
		});
	}

	async function materializeKv(
		baseDir: string,
		{ kv, config }: RegisteredKv,
	): Promise<() => void> {
		const state: Record<string, unknown> = { ...kv.getAll() };
		const serialize = config.serialize ?? defaultKvSerialize;

		const initial = serialize(state);
		await writeFile(join(baseDir, initial.filename), initial.content);

		return kv.observeAll((changes) => {
			void (async () => {
				for (const [key, change] of changes) {
					if (change.type === 'set') state[key] = change.value;
					else delete state[key];
				}
				const result = serialize(state);
				await writeFile(join(baseDir, result.filename), result.content);
			})().catch((cause) => {
				log.warn(AttachMarkdownWriteError.KvWriteFailed({ cause }));
			});
		});
	}

	// ── Disposal ────────────────────────────────────────────────

	function dispose() {
		if (isDisposed) return;
		isDisposed = true;
		// Close the registration window even if `initialize()` never ran
		// (e.g., waitFor stalled and the ydoc was destroyed before init).
		isRegistrationOpen = false;
		for (const entry of registered.values()) entry.unsubscribe?.();
		registeredKv?.unsubscribe?.();
	}

	ydoc.once('destroy', dispose);

	// ── Initial flush ────────────────────────────────────────────

	async function initialize() {
		// Always yield a microtask so callers can finish synchronous setup
		// (including `.table()` / `.kv()` registrations) before the first flush.
		await waitFor;
		// Close the registration window: any further `.table()` / `.kv()` call
		// throws, even if init errors or disposes mid-flight below.
		isRegistrationOpen = false;
		if (isDisposed) return;

		await mkdir(dir, { recursive: true });

		for (const entry of registered.values()) {
			if (isDisposed) return;
			entry.unsubscribe = await materializeTable(dir, entry);
		}

		if (registeredKv && !isDisposed) {
			registeredKv.unsubscribe = await materializeKv(dir, registeredKv);
		}
	}

	const whenLoaded = initialize();

	// ── Push (imports markdown files into workspace tables) ─────

	async function pushMarkdownFiles(): Promise<PushResult> {
		const events: PushEvent[] = [];

		for (const entry of registered.values()) {
			const tableName = entry.table.name;
			const subdir = entry.config.dir ?? tableName;
			const directory = join(dir, subdir);

			let files: string[];
			try {
				files = await readdir(directory);
			} catch {
				continue; // whole directory missing → silently skip the table
			}

			for (const filename of files) {
				if (!filename.endsWith('.md')) continue;

				// Relative to the materializer's base dir: disambiguates two
				// tables writing files with the same name.
				const path = join(subdir, filename);

				// 1. Read
				const { data: content, error: readError } = await tryAsync({
					try: () => readFile(join(directory, filename), 'utf-8'),
					catch: (cause) => AttachMarkdownPushError.ReadFailed({ cause }),
				});
				if (readError) {
					events.push({ kind: 'error', path, tableName, error: readError });
					continue;
				}

				// 2. Parse frontmatter
				const parsed = parseMarkdownFile(content);
				if (!parsed) {
					events.push({ kind: 'skipped', path });
					continue;
				}

				// 3. Run user's fromMarkdown (or default): capture throws as errors
				const fromMarkdown: (p: MarkdownShape) => MaybePromise<BaseRow> =
					entry.config.fromMarkdown ?? defaultFromMarkdown;
				const { data: row, error: callbackError } = await tryAsync({
					try: async () => fromMarkdown(parsed),
					catch: (cause) =>
						AttachMarkdownPushError.FromMarkdownCallbackFailed({ cause }),
				});
				if (callbackError) {
					events.push({ kind: 'error', path, tableName, error: callbackError });
					continue;
				}
				// tryAsync invariant: row is non-null once error is null; satisfies TS.
				if (row == null) continue;

				// 4. Validate the returned row against the table's schema
				const { data: validRow, error: parseError } = entry.table.parse(
					row.id,
					row,
				);
				if (parseError) {
					events.push({ kind: 'error', path, tableName, error: parseError });
					continue;
				}

				// 5. Commit
				entry.table.set(validRow);
				events.push({ kind: 'imported', path, tableName, id: validRow.id });
			}
		}

		let imported = 0;
		let skipped = 0;
		let errored = 0;
		for (const event of events) {
			if (event.kind === 'imported') imported++;
			else if (event.kind === 'skipped') skipped++;
			else errored++;
		}

		return { imported, skipped, errored, events };
	}

	// ── Rebuild (destructive: wipe output dir and re-materialize) ─

	async function rebuildMarkdownFiles(
		tableName?: string,
	): Promise<{ deleted: number; written: number }> {
		let deleted = 0;
		let written = 0;

		const targets =
			tableName !== undefined
				? ([registered.get(tableName)].filter(
						(entry): entry is RegisteredTable => entry !== undefined,
					) as RegisteredTable[])
				: [...registered.values()];

		if (tableName !== undefined && targets.length === 0) {
			throw new Error(
				`Cannot rebuild "${tableName}": not in the materialized table set.`,
			);
		}

		for (const entry of targets) {
			const directory = join(dir, entry.config.dir ?? entry.table.name);

			// Sweep existing .md files
			try {
				const files = await readdir(directory);
				for (const filename of files) {
					if (!filename.endsWith('.md')) continue;
					await unlink(join(directory, filename)).catch(() => {});
					deleted++;
				}
			} catch {
				// Directory doesn't exist yet: fine.
			}

			await mkdir(directory, { recursive: true });
			for (const row of entry.table.getAllValid()) {
				const { filename, content } = await rowToMarkdownFile(row, entry.config);
				await writeMarkdownFile(directory, filename, content);
				written++;
			}
		}

		// Re-materialize KV if registered and this is a full reindex.
		if (tableName === undefined && registeredKv) {
			const { kv, config } = registeredKv;
			const serialize = config.serialize ?? defaultKvSerialize;
			const state = { ...kv.getAll() };
			const result = serialize(state);
			await writeFile(join(dir, result.filename), result.content);
			written++;
		}

		return { deleted, written };
	}

	// ── Builder ──────────────────────────────────────────────────

	const api = {
		whenLoaded,
		push: defineMutation({
			title: 'Push markdown to workspace',
			description:
				'Read markdown files from disk and import rows into registered tables',
			input: Type.Object({}),
			handler: pushMarkdownFiles,
		}),
		pull: defineMutation({
			title: 'Pull workspace to markdown',
			description:
				'Re-serialize all valid rows from registered tables to markdown files on disk',
			input: Type.Object({}),
			handler: async () => {
				let written = 0;
				for (const entry of registered.values()) {
					const directory = join(dir, entry.config.dir ?? entry.table.name);
					await mkdir(directory, { recursive: true });
					for (const row of entry.table.getAllValid()) {
						const { filename, content } = await rowToMarkdownFile(
							row,
							entry.config,
						);
						await writeMarkdownFile(directory, filename, content);
						written++;
					}
				}
				return { written };
			},
		}),
		rebuild: defineMutation({
			title: 'Rebuild markdown files',
			description:
				'Delete existing .md files in registered table directories and re-serialize all valid rows. Destructive: removes orphan files left by deleted rows or stale configs.',
			input: Type.Object({ table: Type.Optional(Type.String()) }),
			handler: ({ table }) => rebuildMarkdownFiles(table),
		}),
	};

	type MaterializerBuilder = typeof api & {
		/**
		 * Opt in a workspace table for markdown materialization.
		 *
		 * Must be called synchronously after construction, before `whenLoaded`
		 * resolves.
		 */
		table<TRow extends BaseRow>(
			table: Table<TRow>,
			config?: TableConfig<TRow>,
		): MaterializerBuilder;
		/**
		 * Opt in the workspace Kv for markdown materialization. Single file on
		 * disk (default `kv.json`) keeps the full Kv state.
		 *
		 * Must be called synchronously after construction, before `whenLoaded`
		 * resolves.
		 */
		kv(kv: AnyKv, config?: KvConfig): MaterializerBuilder;
	};

	const builder: MaterializerBuilder = {
		...api,
		table(table, config) {
			if (!isRegistrationOpen)
				throw new Error(
					`attachMarkdown: .table("${table.name}") called after initial flush. All .table() registrations must happen synchronously after construction.`,
				);
			registered.set(table.name, {
				table: table as AnyTable,
				config: config ?? {},
			});
			return builder;
		},
		kv(kv, config) {
			if (!isRegistrationOpen)
				throw new Error(
					'attachMarkdown: .kv() called after initial flush. All .kv() registrations must happen synchronously after construction.',
				);
			registeredKv = {
				kv: kv as AnyKv,
				config: config ?? {},
			};
			return builder;
		},
	};

	return builder;
}
