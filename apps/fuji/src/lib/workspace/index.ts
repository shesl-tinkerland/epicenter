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
 * Purity invariant: this file imports only isomorphic dependencies
 * (`@epicenter/workspace`, `typebox`, `wellcrafted`, `yjs`). It must never
 * import app-runtime code: no `$lib`/`.svelte`, no `#platform/*`, no browser or
 * Tauri APIs, and nothing from `@epicenter/workspace/daemon`. That purity is
 * what lets the `.` and `./project` package exports stay honest from inside the
 * app without extracting a separate schema package: the wire contract never
 * drags runtime code into a consumer.
 *
 * Composition lives elsewhere:
 *  - `src/lib/workspace/browser.ts` → `openFujiBrowser({ signedIn, nodeId })`
 *  - `src/lib/workspace/mount.ts` → `fuji(opts?)` mount factory
 *  - `examples/fuji/epicenter.config.ts` → canonical Epicenter folder composition
 *
 * The workspace factory returns actions under `workspace.actions`; runtime
 * openers pass that registry to collaboration and can layer runtime-specific
 * commands beside it.
 */

import { field, InstantString } from '@epicenter/field';
import {
	attachRichText,
	DateTimeString,
	defineActions,
	defineMutation,
	defineQuery,
	defineTable,
	defineWorkspace,
	generateId,
	type IanaTimeZone,
	type InferTableRow,
	nullable,
	type WorkspaceFromDefinition,
} from '@epicenter/workspace';
import { Type } from 'typebox';
import type { Brand } from 'wellcrafted/brand';

export const FUJI_ID = 'epicenter-fuji';

export type EntryId = string & Brand<'EntryId'>;

/**
 * Syntactic sugar for `value as EntryId`. The constrained `string` parameter
 * is what earns it over a raw `as` cast (callers can't widen to `unknown`).
 * The only place in the codebase where `as EntryId` should appear.
 */
export const asEntryId = (value: string): EntryId => value as EntryId;

const entriesTable = defineTable({
	id: field.string<EntryId>(),
	title: field.string(),
	subtitle: field.string(),
	type: field.json(Type.Array(Type.String())),
	tags: field.json(Type.Array(Type.String())),
	pinned: field.boolean(),
	deletedAt: nullable(field.instant()),
	// `date` is the canonical UTC instant; `dateZone` carries the originating
	// IANA zone so display code can render the user's local wall-clock time.
	// Per the workspace `<field>` + `<field>Zone` convention.
	date: field.datetime(),
	dateZone: field.string<IanaTimeZone>(),
	createdAt: field.instant(),
	updatedAt: field.instant(),
	rating: field.number(),
}).docs({
	content: {
		layout: attachRichText,
		touch: 'updatedAt',
	},
});

export type Entry = InferTableRow<typeof entriesTable>;

/**
 * Fuji's shared workspace definition.
 *
 * Entry bodies are separate child Y.Docs declared on `entries.content`.
 */
export const fujiWorkspace = defineWorkspace({
	id: FUJI_ID,
	tables: { entries: entriesTable },
	kv: {},
	actions: ({ tables }) =>
		defineActions({
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
					return tables.entries.scan().rows;
				},
			}),
			entries_count: defineQuery({
				title: 'Count Entries',
				description: 'Count entries in the Fuji workspace.',
				handler: () => {
					return tables.entries.storedCount();
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
					const touchedAt = InstantString.now();
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
						createdAt: touchedAt,
						updatedAt: touchedAt,
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
					deletedAt: nullable(
						field.instant({ description: 'Soft deletion timestamp' }),
					),
					date: Type.Unsafe<DateTimeString>({
						type: 'string',
						description: 'User-defined date for the entry (UTC ISO 8601)',
					}),
					dateZone: Type.String({
						description: 'IANA timezone for displaying the entry date',
					}),
					createdAt: Type.Unsafe<InstantString>({
						type: 'string',
						description: 'Creation timestamp',
					}),
					updatedAt: Type.Unsafe<InstantString>({
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
						updatedAt: InstantString.now(),
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
						deletedAt: InstantString.now(),
						updatedAt: InstantString.now(),
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
						updatedAt: InstantString.now(),
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
					const touchedAt = InstantString.now();
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
						createdAt: touchedAt,
						updatedAt: touchedAt,
					}));
					// Fresh generateId() ids cannot collide with a stored row, so
					// bulkSet never refuses on this path; report a clean count.
					await tables.entries.bulkSet(rows);
					return { count: rows.length };
				},
			}),
		}),
});
export type FujiWorkspace = WorkspaceFromDefinition<typeof fujiWorkspace>;

export type FujiActions = FujiWorkspace['actions'];
