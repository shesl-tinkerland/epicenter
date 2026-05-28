/**
 * Fuji workspace contract: id, branded types, table definitions, actions, the
 * workspace factory, and per-row child document models. Isomorphic: no
 * IndexedDB, WebSockets, SQLite files, Svelte state, Tauri APIs, or daemon
 * process lifecycle.
 *
 * Distribution: `apps/fuji/package.json` exports this file as the
 * `@epicenter/fuji` package root. Browser code, daemon code, and tests all
 * import from here. The table shapes here are the wire contract for sync;
 * forking a column shape breaks sync compatibility with peers running the
 * canonical schema.
 *
 * Composition lives elsewhere:
 *  - `apps/fuji/fuji.browser.ts`    → `openFujiBrowser({ signedIn, deviceId })`
 *  - `apps/fuji/project.ts`          → `fuji(opts?)` mount factory
 *  - `examples/fuji/epicenter.config.ts` → canonical project layout composition
 *
 * The workspace factory returns actions under `workspace.actions`; runtime
 * openers pass that registry to collaboration and can layer runtime-specific
 * commands beside it.
 */

import {
	attachRichText,
	column,
	createDisposableCache,
	createWorkspace,
	DateTimeString,
	defineActions,
	defineMutation,
	defineQuery,
	defineTable,
	defineWorkspace,
	docGuid,
	generateId,
	type IanaTimeZone,
	type InferTableRow,
	type Keyring,
	onLocalUpdate,
	type Tables,
} from '@epicenter/workspace';
import { Type } from 'typebox';
import type { Brand } from 'wellcrafted/brand';
import * as Y from 'yjs';

export const FUJI_ID = 'epicenter.fuji';

export type EntryId = string & Brand<'EntryId'>;

/**
 * Syntactic sugar for `value as EntryId`. The constrained `string` parameter
 * is what earns it over a raw `as` cast (callers can't widen to `unknown`).
 * The only place in the codebase where `as EntryId` should appear.
 */
export const asEntryId = (value: string): EntryId => value as EntryId;

const entriesTable = defineTable(
	// v1
	{
		id: column.string<EntryId>(),
		title: column.string(),
		subtitle: column.string(),
		type: column.json(Type.Array(Type.String())),
		tags: column.json(Type.Array(Type.String())),
		pinned: column.boolean(),
		deletedAt: column.nullable(column.dateTime()),
		date: column.dateTime(),
		createdAt: column.dateTime(),
		updatedAt: column.dateTime(),
	},
	// v2: added rating
	{
		id: column.string<EntryId>(),
		title: column.string(),
		subtitle: column.string(),
		type: column.json(Type.Array(Type.String())),
		tags: column.json(Type.Array(Type.String())),
		pinned: column.boolean(),
		deletedAt: column.nullable(column.dateTime()),
		date: column.dateTime(),
		createdAt: column.dateTime(),
		updatedAt: column.dateTime(),
		rating: column.number(),
	},
	// v3: split user-meaningful `date` into UTC `date` + IANA `dateZone`.
	// `date` is the canonical UTC instant; `dateZone` carries the originating
	// IANA zone so display code can render the user's local wall-clock time.
	// Per the workspace `<field>` + `<field>Zone` convention.
	{
		id: column.string<EntryId>(),
		title: column.string(),
		subtitle: column.string(),
		type: column.json(Type.Array(Type.String())),
		tags: column.json(Type.Array(Type.String())),
		pinned: column.boolean(),
		deletedAt: column.nullable(column.dateTime()),
		date: column.dateTime(),
		dateZone: column.ianaTimeZone(),
		createdAt: column.dateTime(),
		updatedAt: column.dateTime(),
		rating: column.number(),
	},
).migrate(({ value, version }) => {
	switch (version) {
		case 1:
			return { ...value, rating: 0, dateZone: 'UTC' as IanaTimeZone };
		case 2:
			return { ...value, dateZone: 'UTC' as IanaTimeZone };
		case 3:
			return value;
	}
});

export type Entry = InferTableRow<typeof entriesTable>;

const fujiTables = { entries: entriesTable };
export type FujiTables = typeof fujiTables;
export type FujiActionHost = { tables: Tables<FujiTables> };

/**
 * Build a Fuji workspace bundle: `{ ydoc, tables, kv, actions, entryContentDocs }`.
 *
 * Encrypted under the supplied keyring; the same factory is used in both
 * browser and daemon entrypoints.
 */
export function createFujiWorkspace(opts: { keyring: () => Keyring }) {
	const workspace = createWorkspace({
		id: FUJI_ID,
		keyring: opts.keyring,
		tables: fujiTables,
		kv: {},
	});
	const actions = createFujiActions(workspace);
	const entryContentDocs = createDisposableCache((entryId: EntryId) => {
		const childYdoc = new Y.Doc({
			guid: entryContentDocGuid(entryId),
			gc: true,
		});
		const body = attachRichText(childYdoc);

		onLocalUpdate(childYdoc, () => {
			workspace.tables.entries.update(entryId, {
				updatedAt: DateTimeString.now(),
			});
		});

		return {
			ydoc: childYdoc,
			body,
			[Symbol.dispose]() {
				childYdoc.destroy();
			},
		};
	});

	return defineWorkspace({
		...workspace,
		actions,
		entryContentDocs,
		[Symbol.dispose]() {
			entryContentDocs[Symbol.dispose]();
			workspace[Symbol.dispose]();
		},
	});
}
export type FujiWorkspace = ReturnType<typeof createFujiWorkspace>;

/**
 * Deterministic guid of an entry's rich-text content sub-doc.
 *
 * Browser editors, daemon materializers, and wipe paths reach this same
 * function so every layer points at the same Y.Doc identity.
 */
export function entryContentDocGuid(entryId: EntryId): string {
	return docGuid({
		workspaceId: FUJI_ID,
		collection: 'entries',
		rowId: entryId,
		field: 'content',
	});
}

export function createFujiActions(workspace: FujiActionHost) {
	const { tables } = workspace;
	return defineActions({
		entries_get: defineQuery({
			title: 'Get Entry',
			description: 'Read one entry by ID from the Fuji workspace.',
			input: Type.Object({
				id: Type.String({ description: 'Entry ID to read' }),
			}),
			handler: ({ id }) => {
				return tables.entries.get(id);
			},
		}),
		entries_get_all_valid: defineQuery({
			title: 'List Valid Entries',
			description: 'Read all valid entries from the Fuji workspace.',
			handler: () => {
				return tables.entries.getAllValid();
			},
		}),
		entries_count: defineQuery({
			title: 'Count Entries',
			description: 'Count entries in the Fuji workspace.',
			handler: () => {
				return tables.entries.count();
			},
		}),
		entries_has: defineQuery({
			title: 'Has Entry',
			description: 'Check whether an entry exists in the Fuji workspace.',
			input: Type.Object({
				id: Type.String({ description: 'Entry ID to check' }),
			}),
			handler: ({ id }) => {
				return tables.entries.has(id);
			},
		}),
		entries_create: defineMutation({
			title: 'Create Entry',
			description:
				'Create a new CMS entry with optional title, subtitle, type, tags, and rating.',
			input: Type.Object({
				title: Type.Optional(Type.String({ description: 'Entry title' })),
				subtitle: Type.Optional(
					Type.String({ description: 'Subtitle for blog listings' }),
				),
				type: Type.Optional(
					Type.Array(Type.String(), {
						description: 'Type classifications',
					}),
				),
				tags: Type.Optional(
					Type.Array(Type.String(), { description: 'Freeform tags' }),
				),
				rating: Type.Optional(
					Type.Number({ description: 'Rating from 0-5 (0 = unrated)' }),
				),
				dateZone: Type.Optional(
					Type.String({
						description:
							'IANA timezone the entry was authored in. Defaults to UTC.',
					}),
				),
			}),
			handler: ({
				title,
				subtitle,
				type: entryType,
				tags,
				rating,
				dateZone,
			}) => {
				const id = generateId<EntryId>();
				const now = DateTimeString.now();
				tables.entries.set({
					id,
					title: title ?? '',
					subtitle: subtitle ?? '',
					type: entryType ?? [],
					tags: tags ?? [],
					pinned: false,
					rating: rating ?? 0,
					deletedAt: null,
					date: now,
					dateZone: (dateZone ?? 'UTC') as IanaTimeZone,
					createdAt: now,
					updatedAt: now,
				});
				return { id };
			},
		}),
		entries_upsert: defineMutation({
			title: 'Upsert Entry',
			description: 'Insert or replace a full entry row.',
			input: Type.Object({
				id: Type.String({ description: 'Entry ID' }),
				title: Type.String({ description: 'Entry title' }),
				subtitle: Type.String({ description: 'Subtitle for blog listings' }),
				type: Type.Array(Type.String(), {
					description: 'Type classifications',
				}),
				tags: Type.Array(Type.String(), { description: 'Freeform tags' }),
				pinned: Type.Boolean({ description: 'Whether the entry is pinned' }),
				rating: Type.Number({ description: 'Rating from 0 to 5' }),
				deletedAt: column.nullable(
					column.dateTime({ description: 'Soft deletion timestamp' }),
				),
				date: Type.Unsafe<DateTimeString>({
					type: 'string',
					description: 'User-defined date for the entry (UTC ISO 8601)',
				}),
				dateZone: Type.String({
					description: 'IANA timezone for displaying the entry date',
				}),
				createdAt: Type.Unsafe<DateTimeString>({
					type: 'string',
					description: 'Creation timestamp',
				}),
				updatedAt: Type.Unsafe<DateTimeString>({
					type: 'string',
					description: 'Last update timestamp',
				}),
			}),
			handler: (row) => {
				tables.entries.set({
					...row,
					id: asEntryId(row.id),
					dateZone: row.dateZone as IanaTimeZone,
				});
				return { id: row.id };
			},
		}),
		entries_update: defineMutation({
			title: 'Update Entry',
			description:
				'Update entry metadata fields. Automatically bumps updatedAt.',
			input: Type.Object({
				id: Type.String({ description: 'Entry ID to update' }),
				title: Type.Optional(Type.String({ description: 'Entry title' })),
				subtitle: Type.Optional(
					Type.String({ description: 'Subtitle for blog listings' }),
				),
				type: Type.Optional(
					Type.Array(Type.String(), {
						description: 'Type classifications',
					}),
				),
				tags: Type.Optional(
					Type.Array(Type.String(), { description: 'Freeform tags' }),
				),
				rating: Type.Optional(
					Type.Number({ description: 'Rating from 0-5 (0 = unrated)' }),
				),
				date: Type.Optional(
					Type.Unsafe<DateTimeString>({
						type: 'string',
						description: 'User-defined date for the entry (UTC ISO 8601)',
					}),
				),
				dateZone: Type.Optional(
					Type.String({
						description: 'IANA timezone for displaying the entry date',
					}),
				),
			}),
			handler: ({ id, dateZone, ...fields }) => {
				return tables.entries.update(id, {
					...fields,
					...(dateZone !== undefined && {
						dateZone: dateZone as IanaTimeZone,
					}),
					updatedAt: DateTimeString.now(),
				});
			},
		}),
		entries_delete: defineMutation({
			title: 'Delete Entry',
			description: 'Soft-delete an entry by setting deletedAt to now.',
			input: Type.Object({
				id: Type.String({ description: 'Entry ID to soft-delete' }),
			}),
			handler: ({ id }) => {
				return tables.entries.update(id, {
					deletedAt: DateTimeString.now(),
					updatedAt: DateTimeString.now(),
				});
			},
		}),
		entries_restore: defineMutation({
			title: 'Restore Entry',
			description: 'Restore a soft-deleted entry by clearing deletedAt.',
			input: Type.Object({
				id: Type.String({ description: 'Entry ID to restore' }),
			}),
			handler: ({ id }) => {
				return tables.entries.update(id, {
					deletedAt: null,
					updatedAt: DateTimeString.now(),
				});
			},
		}),
		entries_bulk_create: defineMutation({
			title: 'Bulk Create Entries',
			description:
				'Create multiple entries at once from title + (date, dateZone) pairs.',
			input: Type.Object({
				dateZone: Type.String({
					description:
						'IANA timezone the entries were authored in. Applied to every row.',
				}),
				entries: Type.Array(
					Type.Object({
						title: Type.String({ description: 'Entry title' }),
						date: Type.String({
							description: 'UTC ISO 8601 instant for the entry',
						}),
					}),
				),
			}),
			handler: async ({ dateZone, entries: items }) => {
				const now = DateTimeString.now();
				const rows = items.map(({ title, date }) => ({
					id: generateId<EntryId>(),
					title,
					subtitle: '',
					type: [] as string[],
					tags: [] as string[],
					pinned: false,
					rating: 0,
					deletedAt: null,
					date: date as DateTimeString,
					dateZone: dateZone as IanaTimeZone,
					createdAt: now,
					updatedAt: now,
				}));
				await tables.entries.bulkSet(rows);
				return { count: rows.length };
			},
		}),
	});
}

export type FujiActions = ReturnType<typeof createFujiActions>;
