/**
 * Wiki workspace contract: id, the two tables, the runtime "define a type" /
 * "create a page" actions, and the workspace factory.
 *
 * Isomorphic, mirroring fuji's `src/lib/workspace/index.ts`: this file imports
 * only isomorphic dependencies (`@epicenter/workspace`, `typebox`,
 * `wellcrafted`). Filesystem wiring (the markdown vault) lives in
 * `./markdown.ts`; the per-type SQLite index lives in `./projection.ts`.
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
import { Ok, type Result } from 'wellcrafted/result';
import {
	isTSchemaObject,
	type PageId,
	type PageTypeValues,
	TYPE_ID_PATTERN,
	type TypeId,
	type WikiType,
	wikiTableDefinitions,
} from './schema';

export const WIKI_ID = 'epicenter-wiki';

export const WikiActionError = defineErrors({
	/** A type id is not a stable slug ([a-z0-9_]+); it also names a SQL table. */
	InvalidTypeId: ({ typeId }: { typeId: string }) => ({
		message: `Type id "${typeId}" must be a slug matching ${TYPE_ID_PATTERN}`,
		typeId,
	}),
	/** A type definition carries a column whose `schema` is not a TSchema object. */
	InvalidColumnSchema: ({
		typeId,
		columnId,
	}: {
		typeId: string;
		columnId: string;
	}) => ({
		message: `Type "${typeId}" column "${columnId}" schema must be a TSchema object (a column.* result)`,
		typeId,
		columnId,
	}),
});
export type WikiActionError = InferErrors<typeof WikiActionError>;

const columnSpecInput = Type.Object({
	id: Type.String(),
	name: Type.String(),
	schema: Type.Unknown({
		description: 'A column.* result (a TypeBox TSchema)',
	}),
});

const typeValuesInput = Type.Record(
	Type.String(),
	Type.Record(Type.String(), Type.Unknown()),
);

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
		types_define: defineMutation({
			title: 'Define Type',
			description:
				'Register a user-defined type (a Tana supertag) with a column schema.',
			input: Type.Object({
				id: Type.String({ description: 'Stable slug, e.g. youtube_video' }),
				name: Type.String({ description: 'Display name' }),
				icon: Type.Optional(Type.Union([Type.String(), Type.Null()])),
				columns: Type.Array(columnSpecInput),
			}),
			handler: ({
				id,
				name,
				icon,
				columns,
			}): Result<{ id: TypeId }, WikiActionError> => {
				// Validate the id at definition time, where the cause is visible.
				// The same slug rule is re-checked in projection (it names a SQL
				// table) as defense in depth, but this is the gate that fails early.
				if (!TYPE_ID_PATTERN.test(id)) {
					return WikiActionError.InvalidTypeId({ typeId: id });
				}
				// A type whose column schema is not a TSchema object is not worth
				// storing; it would only fail validation and projection later.
				for (const spec of columns) {
					if (!isTSchemaObject(spec.schema)) {
						return WikiActionError.InvalidColumnSchema({
							typeId: id,
							columnId: spec.id,
						});
					}
				}
				const now = DateTimeString.now();
				tables.types.set({
					id: id as TypeId,
					name,
					icon: icon ?? null,
					columns: columns as unknown as WikiType['columns'],
					createdAt: now,
					updatedAt: now,
				});
				return Ok({ id: id as TypeId });
			},
		}),

		pages_create: defineMutation({
			title: 'Create Page',
			description:
				'Create a wiki page with core fields, an optional body, and optional type values.',
			input: Type.Object({
				title: Type.Optional(Type.String()),
				description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
				tags: Type.Optional(Type.Array(Type.String())),
				source: Type.Optional(Type.Array(Type.String())),
				types: Type.Optional(typeValuesInput),
				body: Type.Optional(Type.String()),
			}),
			handler: ({ title, description, tags, source, types, body }) => {
				const id = generateId<PageId>();
				const now = DateTimeString.now();
				tables.pages.set({
					id,
					title: title ?? '',
					description: description ?? null,
					tags: tags ?? [],
					source: source ?? [],
					types: (types ?? {}) as PageTypeValues,
					body: body ?? '',
					createdAt: now,
					updatedAt: now,
				});
				return { id };
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
			handler: () => tables.pages.scan().rows,
		}),

		types_get_all: defineQuery({
			title: 'List Types',
			description: 'Read every user-defined type.',
			handler: () => tables.types.scan().rows,
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
