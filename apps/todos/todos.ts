import { field, InstantString } from '@epicenter/field';
import {
	createWorkspace,
	defineActions,
	defineMutation,
	defineTable,
	defineWorkspace,
	generateId,
	type InferTableRow,
	nullable,
} from '@epicenter/workspace';
import Type from 'typebox';
import type { Brand } from 'wellcrafted/brand';

export const TODOS_ID = 'epicenter-todos';

export type TodoId = string & Brand<'TodoId'>;
const generateTodoId = (): TodoId => generateId<TodoId>();

/**
 * Built-in contexts are the complete, fixed set of contexts in this slice:
 * code constants, never table rows, always present and undeletable. A todo's
 * `contexts` is a subset of these slugs. The constants-not-rows shape (and the
 * tolerant stored schema below) leaves room to layer user-created contexts back
 * in as rows in a later slice without changing the file format.
 */
export const BUILT_IN_CONTEXTS = [
	{ id: 'phone', name: 'Phone', color: 'sky' },
	{ id: 'computer', name: 'Computer', color: 'violet' },
	{ id: 'desk', name: 'Desk', color: 'emerald' },
] as const;

export type ContextSlug = (typeof BUILT_IN_CONTEXTS)[number]['id'];

const BUILT_IN_CONTEXT_IDS = new Set<ContextSlug>(
	BUILT_IN_CONTEXTS.map((context) => context.id),
);

function isContextSlug(value: unknown): value is ContextSlug {
	return (
		typeof value === 'string' && BUILT_IN_CONTEXT_IDS.has(value as ContextSlug)
	);
}

/**
 * The stored `contexts` field tolerates any string, so a hand-edited file or a
 * mid-sync row carrying an unknown slug stays legal (the UI renders it as a
 * neutral chip). The create path is stricter: it only accepts built-in slugs.
 */
const contextSlugSchema = Type.Unsafe<ContextSlug>(Type.String());

const todosTable = defineTable({
	id: field.string<TodoId>(),
	title: field.string({ minLength: 1 }),
	body: field.string(),
	dueDate: nullable(field.date()),
	contexts: field.json(Type.Array(contextSlugSchema)),
	completedAt: nullable(field.instant()),
	deletedAt: nullable(field.instant()),
	createdAt: field.instant(),
});
export type Todo = InferTableRow<typeof todosTable>;

function normalizeContextSlugs(slugs: readonly string[]): ContextSlug[] {
	const unique = new Set<ContextSlug>();
	for (const slug of slugs) {
		if (!isContextSlug(slug)) throw new Error(`Unknown context: ${slug}`);
		unique.add(slug);
	}
	return [...unique];
}

export function createTodos() {
	const workspace = createWorkspace({
		id: TODOS_ID,
		tables: { todos: todosTable },
		kv: {},
	});
	const { tables } = workspace;

	return defineWorkspace({
		...workspace,
		actions: defineActions({
			todos_create: defineMutation({
				description: 'Create a todo',
				input: Type.Object({
					title: Type.String(),
					body: Type.Optional(Type.String()),
					dueDate: Type.Optional(Type.Union([field.date(), Type.Null()])),
					contexts: Type.Optional(Type.Array(contextSlugSchema)),
				}),
				handler: (input) => {
					const title = input.title.trim();
					if (title === '') throw new Error('Todo title is required');
					const row: Todo = {
						id: generateTodoId(),
						title,
						body: input.body ?? '',
						dueDate: input.dueDate ?? null,
						contexts: normalizeContextSlugs(input.contexts ?? []),
						completedAt: null,
						deletedAt: null,
						createdAt: InstantString.now(),
					};
					tables.todos.set(row);
					return row.id;
				},
			}),
			todos_set_completed: defineMutation({
				description: 'Mark a todo complete or incomplete',
				input: Type.Object({
					id: Type.Unsafe<TodoId>(Type.String()),
					completed: Type.Boolean(),
				}),
				handler: (input) => {
					tables.todos.update(input.id, {
						completedAt: input.completed ? InstantString.now() : null,
					});
				},
			}),
			todos_delete: defineMutation({
				description: 'Soft-delete a todo',
				input: Type.Object({ id: Type.Unsafe<TodoId>(Type.String()) }),
				handler: (input) => {
					tables.todos.update(input.id, { deletedAt: InstantString.now() });
				},
			}),
		}),
	});
}
