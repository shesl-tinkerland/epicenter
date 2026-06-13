/**
 * @fileoverview Pure action factory for the skills workspace.
 *
 * Extracted from the closure so both the browser (`./index.ts`) and node
 * (`./node.ts`) document factories can share the three read actions. The
 * node entry builds on top of this to add `import_from_disk` / `export_to_disk`.
 *
 * @module
 */

import { defineActions, defineQuery, type Table } from '@epicenter/workspace';
import Type from 'typebox';
import type { Reference, Skill } from './tables.js';

export type SkillsTables = {
	skills: Table<Skill>;
	references: Table<Reference>;
};

export function createSkillsActions({
	tables,
	readInstructions,
	readReference,
}: {
	tables: SkillsTables;
	readInstructions(id: string): Promise<string>;
	readReference(id: string): Promise<string>;
}) {
	return defineActions({
		/** List all skills as lightweight catalog entries: no docs opened. */
		list_skills: defineQuery({
			description: 'List all skills (id, name, description)',
			handler: () =>
				tables.skills
					.scan()
					.rows.map((s) => ({
						id: s.id,
						name: s.name,
						description: s.description,
					}))
					.sort((a, b) => a.name.localeCompare(b.name)),
		}),

		/** Get a single skill's metadata and instructions. Opens one Y.Doc. */
		get_skill: defineQuery({
			description: 'Get skill metadata and instructions by ID',
			input: Type.Object({ id: Type.String() }),
			handler: async ({ id }) => {
				const skill = tables.skills.findValid((s) => s.id === id);
				if (!skill) return null;
				const instructions = await readInstructions(id);
				return { skill, instructions };
			},
		}),

		/** Get a skill with full instructions and all reference content. */
		get_skill_with_references: defineQuery({
			description: 'Get skill with instructions and all reference content',
			input: Type.Object({ id: Type.String() }),
			handler: async ({ id }) => {
				const skill = tables.skills.findValid((s) => s.id === id);
				if (!skill) return null;
				const instructions = await readInstructions(id);
				const refs = tables.references
					.scan()
					.rows.filter((r) => r.skillId === id);
				const references = await Promise.all(
					refs.map(async (ref) => ({
						path: ref.path,
						content: await readReference(ref.id),
					})),
				);
				return {
					skill,
					instructions,
					references: references.sort((a, b) => a.path.localeCompare(b.path)),
				};
			},
		}),
	});
}
