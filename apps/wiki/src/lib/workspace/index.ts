/**
 * Wiki workspace contract: id, the two tables, the runtime "define a tag" /
 * "create a page" / "assign a tag" actions, and the workspace factory.
 *
 * Isomorphic, mirroring fuji's `src/lib/workspace/index.ts`: this file imports
 * only isomorphic dependencies (`@epicenter/workspace`, `typebox`,
 * `wellcrafted`). Filesystem wiring (the markdown vault) lives in
 * `./markdown.ts`; the SQLite projection lives in `./projection.ts`.
 *
 * `body` is a row column for this slice (see `./schema.ts`), so there is no
 * per-page content doc to open here; the markdown codec routes it to the file
 * body. Promote it to a child `Y.Doc` when collaborative body editing is real.
 */

import {
	createWorkspace,
	DateTimeString,
	defineActions,
	defineMutation,
	defineQuery,
	defineWorkspace,
	generateId,
	type Keyring,
} from '@epicenter/workspace';
import { Type } from 'typebox';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	buildColumnSchema,
	COLUMN_ID_PATTERN,
	type ColumnInput,
	type ColumnSpec,
	type Page,
	type PageId,
	type PageTagValues,
	RESERVED_TAG_ID,
	type TagId,
	tagColumns,
	TAG_ID_PATTERN,
	type WikiTag,
	wikiTableDefinitions,
} from './schema';

export const WIKI_ID = 'epicenter-wiki';

export const WikiActionError = defineErrors({
	/** A tag id is not a stable slug ([a-z][a-z0-9_]*); it also names a SQL table. */
	InvalidTagId: ({ tagId }: { tagId: string }) => ({
		message: `Tag id "${tagId}" must be a slug matching ${TAG_ID_PATTERN}`,
		tagId,
	}),
	/** The reserved tag id `columns` (kept clear of an internal-sounding name). */
	ReservedTagId: ({ tagId }: { tagId: string }) => ({
		message: `Tag id "${tagId}" is reserved`,
		tagId,
	}),
	/** A tag edit named a tag id with no registry row. */
	TagNotFound: ({ tagId }: { tagId: string }) => ({
		message: `No tag with id "${tagId}"`,
		tagId,
	}),
	/** A column id is not a stable slug ([a-z][a-z0-9_]*) or collides with the page_id PK. */
	InvalidColumnId: ({ columnId }: { columnId: string }) => ({
		message: `Column id "${columnId}" must be a slug matching ${COLUMN_ID_PATTERN} and not "page_id"`,
		columnId,
	}),
	/** An `enum` column was authored with no allowed values. */
	EnumValuesRequired: ({ columnId }: { columnId: string }) => ({
		message: `Column "${columnId}" is an enum and needs at least one value`,
		columnId,
	}),
	/** A body write or tag assignment named a page id that has no row. */
	PageNotFound: ({ id }: { id: string }) => ({
		message: `No page with id "${id}"`,
		id,
	}),
	/** A body_patch anchor (the exact text to replace) was not present in the body. */
	AnchorNotFound: ({ id, old }: { id: string; old: string }) => ({
		message: `Anchor not found in page "${id}": the exact text to replace is not present in the body`,
		id,
		old,
	}),
	/** A body_patch anchor appears more than once, so the target is ambiguous. */
	AnchorAmbiguous: ({ id, old }: { id: string; old: string }) => ({
		message: `Anchor is ambiguous in page "${id}": the text to replace appears more than once; include more surrounding context`,
		id,
		old,
	}),
});
export type WikiActionError = InferErrors<typeof WikiActionError>;

/**
 * The column authoring descriptor (see `ColumnInput`). `kind` is a closed
 * literal union, so `invokeAction`'s input validation rejects an unknown kind
 * before the handler runs: an agent picks from a menu, never hand-writes JSON
 * Schema, and no junk schema can be stored.
 */
const columnInputSchema = Type.Object({
	id: Type.String({ description: 'Stable column slug, e.g. duration' }),
	name: Type.String({ description: 'Display name' }),
	kind: Type.Union(
		[
			Type.Literal('string'),
			Type.Literal('number'),
			Type.Literal('integer'),
			Type.Literal('boolean'),
			Type.Literal('datetime'),
			Type.Literal('url'),
			Type.Literal('enum'),
		],
		{
			description:
				'Column kind (closed set). A reference is just a string holding an epicenter:// URN, found by value.',
		},
	),
	nullable: Type.Optional(Type.Boolean({ description: 'Allow null' })),
	array: Type.Optional(Type.Boolean({ description: 'A list of the kind' })),
	enumValues: Type.Optional(
		Type.Array(Type.String(), {
			description: 'Allowed values; required when kind is enum',
		}),
	),
});

/**
 * Validate one authoring descriptor and compile it to a stored `ColumnSpec`. The
 * `kind` is already validated by the action input layer; this catches the two
 * domain rules that layer cannot: the column id must be a slug (it becomes a
 * bare SQL column name) and an `enum` must carry values.
 */
function compileColumn(input: ColumnInput): Result<ColumnSpec, WikiActionError> {
	if (!COLUMN_ID_PATTERN.test(input.id) || input.id === 'page_id') {
		return WikiActionError.InvalidColumnId({ columnId: input.id });
	}
	if (input.kind === 'enum' && !(input.enumValues && input.enumValues.length)) {
		return WikiActionError.EnumValuesRequired({ columnId: input.id });
	}
	return Ok({ id: input.id, name: input.name, schema: buildColumnSchema(input) });
}

const tagValuesInput = Type.Record(
	Type.String(),
	Type.Record(Type.String(), Type.Unknown()),
);

/**
 * The slice of the wiki tables handle the auto-mint helper needs: just enough
 * of the `tags` table to look a row up and upsert a bare one.
 */
type TagsRegistry = {
	tags: {
		get(id: string): { data: WikiTag | null };
		set(row: WikiTag): void;
	};
};

/**
 * Auto-mint a bare tag definition for every assigned tag with no registry row.
 *
 * Typing `#newidea` (assigning a tag that was never defined) upserts
 * `{ id, name: id, columns: [], description: null }`. Capture stays instant;
 * promote later by adding columns. `pages_create` and `pages_assign_tag` both
 * call this, so `page_tags` always resolves to a real row. Invalid slugs are
 * skipped (the caller validates them where the cause is visible); a valid but
 * unwanted slug is acceptable junk, same risk as a free-text tag.
 */
function mintMissingTags(tables: TagsRegistry, tagIds: Iterable<string>): void {
	const now = DateTimeString.now();
	for (const tagId of tagIds) {
		if (!TAG_ID_PATTERN.test(tagId) || tagId === RESERVED_TAG_ID) continue;
		if (tables.tags.get(tagId).data) continue;
		tables.tags.set({
			id: tagId as TagId,
			name: tagId,
			icon: null,
			columns: [],
			description: null,
			createdAt: now,
			updatedAt: now,
		});
	}
}

/**
 * Build a Wiki workspace: `{ ydoc, tables, kv, actions }`.
 *
 * `keyring` is optional (the headless slice runs without encryption); real
 * runtimes pass one, exactly as fuji does.
 */
export function createWiki(opts?: { keyring?: () => Keyring }) {
	const workspace = createWorkspace({
		id: WIKI_ID,
		keyring: opts?.keyring,
		tables: wikiTableDefinitions,
		kv: {},
	});
	const { tables } = workspace;

	const actions = defineActions({
		tags_define: defineMutation({
			title: 'Define Tag',
			description:
				'Register a tag (a reusable annotation / schema facet). Empty columns = a plain tag; columns make it a structured tag with its own SQLite table.',
			input: Type.Object({
				id: Type.String({ description: 'Stable slug, e.g. youtube_video' }),
				name: Type.String({ description: 'Display name' }),
				icon: Type.Optional(Type.Union([Type.String(), Type.Null()])),
				columns: Type.Array(columnInputSchema),
				description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			}),
			handler: ({
				id,
				name,
				icon,
				columns,
				description,
			}): Result<{ id: TagId }, WikiActionError> => {
				// Validate the id at definition time, where the cause is visible.
				// The same slug rule is re-checked in projection (it names a SQL
				// table) as defense in depth, but this is the gate that fails early.
				if (!TAG_ID_PATTERN.test(id)) {
					return WikiActionError.InvalidTagId({ tagId: id });
				}
				if (id === RESERVED_TAG_ID) {
					return WikiActionError.ReservedTagId({ tagId: id });
				}
				// Compile each descriptor to its stored schema, bailing on the first
				// bad column (a non-slug id, or an enum with no values).
				const specs: ColumnSpec[] = [];
				for (const col of columns) {
					const { data: spec, error } = compileColumn(col);
					if (error) return Err(error);
					specs.push(spec!);
				}
				const now = DateTimeString.now();
				tables.tags.set({
					id: id as TagId,
					name,
					icon: icon ?? null,
					columns: specs as unknown as WikiTag['columns'],
					description: description ?? null,
					createdAt: now,
					updatedAt: now,
				});
				return Ok({ id: id as TagId });
			},
		}),

		tags_set_column: defineMutation({
			title: 'Set Tag Column',
			description:
				'Add or change one typed column on an existing tag (upsert by column id). Rename = same id with a new name (no DDL); retype = same id with a new kind. The agent picks a kind from a closed menu; it never writes a schema by hand.',
			input: Type.Object({
				tagId: Type.String({ description: 'The tag to edit' }),
				column: columnInputSchema,
			}),
			handler: ({
				tagId,
				column,
			}): Result<{ tagId: string; columnId: string }, WikiActionError> => {
				const { data: tag } = tables.tags.get(tagId);
				if (!tag) return WikiActionError.TagNotFound({ tagId });
				const { data: spec, error } = compileColumn(column);
				if (error) return Err(error);
				const existing = tagColumns(tag);
				const next = existing.some((c) => c.id === spec!.id)
					? existing.map((c) => (c.id === spec!.id ? spec! : c))
					: [...existing, spec!];
				tables.tags.set({
					...tag,
					columns: next as unknown as WikiTag['columns'],
					updatedAt: DateTimeString.now(),
				});
				return Ok({ tagId, columnId: spec!.id });
			},
		}),

		tags_remove_column: defineMutation({
			title: 'Remove Tag Column',
			description:
				'Drop one column from a tag by id (a no-op if the column is absent). Stored page values for it survive in Yjs; they just stop projecting.',
			input: Type.Object({
				tagId: Type.String(),
				columnId: Type.String(),
			}),
			handler: ({
				tagId,
				columnId,
			}): Result<{ tagId: string }, WikiActionError> => {
				const { data: tag } = tables.tags.get(tagId);
				if (!tag) return WikiActionError.TagNotFound({ tagId });
				const next = tagColumns(tag).filter((c) => c.id !== columnId);
				tables.tags.set({
					...tag,
					columns: next as unknown as WikiTag['columns'],
					updatedAt: DateTimeString.now(),
				});
				return Ok({ tagId });
			},
		}),

		pages_create: defineMutation({
			title: 'Create Page',
			description:
				'Create a wiki page with a title, an optional body, and an optional tags map. Unknown tags auto-mint a bare definition.',
			input: Type.Object({
				title: Type.Optional(Type.String()),
				tags: Type.Optional(tagValuesInput),
				body: Type.Optional(Type.String()),
			}),
			handler: ({ title, tags, body }) => {
				const id = generateId<PageId>();
				const now = DateTimeString.now();
				const tagValues = (tags ?? {}) as PageTagValues;
				// Assigning a tag at creation mints it, same as the assign action.
				mintMissingTags(tables, Object.keys(tagValues));
				tables.pages.set({
					id,
					title: title ?? '',
					body: body ?? '',
					tags: tagValues,
					createdAt: now,
					updatedAt: now,
				});
				return { id };
			},
		}),

		pages_assign_tag: defineMutation({
			title: 'Assign Tag',
			description:
				'Wear a tag on a page, with optional column values. An unknown tag auto-mints a bare definition. A page wears each tag at most once; re-assigning overwrites the values.',
			input: Type.Object({
				id: Type.String({ description: 'The page id' }),
				tagId: Type.String({ description: 'The tag slug to wear' }),
				values: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
			}),
			/**
			 * Auto-mint at the write boundary so `page_tags` always resolves, and
			 * never block on a dangling `epicenter://` reference value: references
			 * may dangle (wiki red-link behavior), discoverable later as an `edges`
			 * LEFT JOIN.
			 */
			handler: ({ id, tagId, values }): Result<Page, WikiActionError> => {
				if (!TAG_ID_PATTERN.test(tagId)) {
					return WikiActionError.InvalidTagId({ tagId });
				}
				if (tagId === RESERVED_TAG_ID) {
					return WikiActionError.ReservedTagId({ tagId });
				}
				const { data: page } = tables.pages.get(id);
				if (!page) return WikiActionError.PageNotFound({ id });
				mintMissingTags(tables, [tagId]);
				const updated: Page = {
					...page,
					tags: {
						...page.tags,
						[tagId]: (values ?? {}) as unknown as PageTagValues[string],
					},
					updatedAt: DateTimeString.now(),
				};
				tables.pages.set(updated);
				return Ok(updated);
			},
		}),

		pages_set_body: defineMutation({
			title: 'Set Page Body',
			description:
				'Overwrite a page body with new markdown (the whole-rewrite shape). Returns the updated page so the caller never has to re-read the file.',
			input: Type.Object({
				id: Type.String(),
				body: Type.String({ description: 'The full new markdown body' }),
			}),
			/**
			 * The agent-path body write: text in, whole-row LWW write out. There is
			 * no codec and no round-trip; the body is a plain string column, so the
			 * materialized markdown is this value verbatim. Promote to a `Y.Text`
			 * child doc with a positional diff only when concurrent body editing is
			 * real (see `./schema.ts`).
			 */
			handler: ({ id, body }): Result<Page, WikiActionError> => {
				const { data: page } = tables.pages.get(id);
				if (!page) return WikiActionError.PageNotFound({ id });
				const updated = { ...page, body, updatedAt: DateTimeString.now() };
				tables.pages.set(updated);
				return Ok(updated);
			},
		}),

		pages_patch_body: defineMutation({
			title: 'Patch Page Body',
			description:
				'Anchored search/replace on a page body, mirroring a coding agent str_replace. Fails loud if the anchor is missing or appears more than once.',
			input: Type.Object({
				id: Type.String(),
				old: Type.String({
					description: 'Exact existing substring to replace; must be unique',
				}),
				new: Type.String({ description: 'Replacement text' }),
			}),
			/**
			 * `slice` splice, not `String.replace`: a string `replace` hits only the
			 * first match and interprets `$` sequences in the replacement, both silent
			 * bugs. We locate the single occurrence, reject zero or multiple matches,
			 * and splice exactly that range. The anchor check doubles as a staleness
			 * guard: a stale read fails here instead of corrupting the body.
			 */
			handler: ({
				id,
				old,
				new: replacement,
			}): Result<Page, WikiActionError> => {
				const { data: page } = tables.pages.get(id);
				if (!page) return WikiActionError.PageNotFound({ id });
				const at = page.body.indexOf(old);
				if (at < 0) return WikiActionError.AnchorNotFound({ id, old });
				if (page.body.indexOf(old, at + old.length) >= 0) {
					return WikiActionError.AnchorAmbiguous({ id, old });
				}
				const body =
					page.body.slice(0, at) +
					replacement +
					page.body.slice(at + old.length);
				const updated = { ...page, body, updatedAt: DateTimeString.now() };
				tables.pages.set(updated);
				return Ok(updated);
			},
		}),

		pages_get: defineQuery({
			title: 'Get Page',
			description: 'Read one page by id.',
			input: Type.Object({ id: Type.String() }),
			handler: ({ id }) => tables.pages.get(id),
		}),

		pages_get_all: defineQuery({
			title: 'List Pages',
			description: 'Read every valid page.',
			handler: () => tables.pages.getAllValid(),
		}),

		tags_get_all: defineQuery({
			title: 'List Tags',
			description: 'Read every tag definition.',
			handler: () => tables.tags.getAllValid(),
		}),
	});

	return defineWorkspace({
		...workspace,
		actions,
		[Symbol.dispose]() {
			workspace[Symbol.dispose]();
		},
	});
}

export type WikiWorkspace = ReturnType<typeof createWiki>;
