/**
 * @fileoverview Server-side entry for the shared skills workspace.
 *
 * Exports `openSkillsNode`: a direct Node/Bun workspace opener with
 * NO IndexedDB / BroadcastChannel attachments and WITH `import_from_disk` /
 * `export_to_disk` actions.
 *
 * Uses the same `SKILLS_WORKSPACE_ID` guid as the browser entry, so data
 * authored on either side targets the same logical Y.Doc.
 *
 * @example
 * ```typescript
 * import { openSkillsNode } from '@epicenter/skills/node';
 *
 * using workspace = openSkillsNode({ workspaceId: 'epicenter-skills' });
 * await workspace.actions.import_from_disk({ dir: '.agents/skills' });
 * await workspace.actions.export_to_disk({ dir: '.agents/skills' });
 * ```
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	attachPlainText,
	defineActions,
	defineMutation,
	generateId,
	onLocalUpdate,
} from '@epicenter/workspace';
import Type from 'typebox';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, tryAsync } from 'wellcrafted/result';
import * as Y from 'yjs';
import { parseSkillMd } from './parse.js';
import { referenceContentDocGuid } from './reference-content-docs.js';
import { serializeSkillMd } from './serialize.js';
import { skillInstructionsDocGuid } from './skill-instructions-docs.js';
import { createSkillsActions } from './skills-actions.js';
import type { Skill } from './tables.js';
import { createSkills } from './workspace.js';

export { SKILLS_WORKSPACE_ID } from './constants.js';
export type { Reference, Skill } from './tables.js';
export { referencesTable, skillsTable } from './tables.js';

const DirInput = Type.Object({ dir: Type.String() });

export const SkillsIoError = defineErrors({
	ScanDirectoryFailed: ({ dir, cause }: { dir: string; cause: unknown }) => ({
		message: `Failed to scan directory '${dir}': ${extractErrorMessage(cause)}`,
		dir,
		cause,
	}),
});
export type SkillsIoError = InferErrors<typeof SkillsIoError>;

/**
 * Open a skills workspace for Node/Bun runtimes. No IndexedDB, no broadcast
 * channel. Callers layer their own persistence if needed. The returned
 * bundle includes `import_from_disk` and `export_to_disk` actions alongside the
 * standard read actions.
 *
 * Uses `SKILLS_WORKSPACE_ID`, the same guid as the browser entry, so
 * data parity across environments is preserved at the CRDT level.
 *
 * Child instruction and reference documents are opened per operation. Node
 * scripts do not need the browser cache's shared live identity or local
 * IndexedDB reset behavior.
 */
export function openSkillsNode({ workspaceId }: { workspaceId: string }) {
	const doc = createSkills({ workspaceId });
	const { tables } = doc;

	function openInstructionsDoc(skillId: string) {
		const ydoc = new Y.Doc({
			guid: skillInstructionsDocGuid({ workspaceId, skillId }),
			gc: true,
		});
		onLocalUpdate(ydoc, () =>
			tables.skills.update(skillId, { updatedAt: Date.now() }),
		);
		return {
			ydoc,
			instructions: attachPlainText(ydoc),
			whenReady: Promise.resolve(),
			[Symbol.dispose]() {
				ydoc.destroy();
			},
		};
	}

	function openReferenceDoc(referenceId: string) {
		const ydoc = new Y.Doc({
			guid: referenceContentDocGuid({ workspaceId, referenceId }),
			gc: true,
		});
		onLocalUpdate(ydoc, () =>
			tables.references.update(referenceId, { updatedAt: Date.now() }),
		);
		return {
			ydoc,
			content: attachPlainText(ydoc),
			whenReady: Promise.resolve(),
			[Symbol.dispose]() {
				ydoc.destroy();
			},
		};
	}

	const readActions = createSkillsActions({
		tables,
		async readInstructions(skillId) {
			using handle = openInstructionsDoc(skillId);
			await handle.whenReady;
			return handle.instructions.read();
		},
		async readReference(referenceId) {
			using handle = openReferenceDoc(referenceId);
			await handle.whenReady;
			return handle.content.read();
		},
	});

	const nodeActions = defineActions({
		/**
		 * Scan a directory of SKILL.md files and upsert them into the workspace.
		 *
		 * Skills without a `metadata.id` in their frontmatter get one generated
		 * and written back to the file, so future imports produce stable IDs
		 * across machines. If two skills in the same batch collide on id, the
		 * second gets a fresh one and its SKILL.md is rewritten.
		 *
		 * References in `references/*.md` subdirectories are imported with
		 * deterministic IDs derived from `skillId + filename`: no ephemeral IDs,
		 * no matching needed.
		 */
		import_from_disk: defineMutation({
			description: 'Import skills from an agentskills.io-compliant directory',
			input: DirInput,
			handler: async ({ dir }) => {
				const entries = await readdir(dir, { withFileTypes: true });
				const skillDirs = entries.filter((e) => e.isDirectory());

				// Phase 1: Read and parse all SKILL.md files in parallel
				const reads = await Promise.all(
					skillDirs.map(async (skillDir) => {
						const skillPath = join(dir, skillDir.name);
						const { data: rawContent } = await tryAsync({
							try: () => readFile(join(skillPath, 'SKILL.md'), 'utf-8'),
							catch: () => Ok(null),
						});
						if (rawContent === null) return null;

						const { skill: parsedSkill, instructions } = parseSkillMd(
							skillDir.name,
							rawContent,
						);
						return { skillPath, parsedSkill, instructions };
					}),
				);

				// Phase 2: Assign IDs sequentially (dedup requires ordering),
				// then import references in parallel within each skill
				const seenIds = new Set<string>();

				for (const entry of reads) {
					if (entry === null) continue;
					const { skillPath, parsedSkill, instructions } = entry;

					const hasUniqueId =
						parsedSkill.id !== null && !seenIds.has(parsedSkill.id);
					const skillId: string = hasUniqueId
						? (parsedSkill.id as string)
						: generateId();
					seenIds.add(skillId);

					const skill = {
						...parsedSkill,
						id: skillId,
						updatedAt: Date.now(),
					} satisfies Skill;
					tables.skills.set(skill);

					// Write back SKILL.md with the id baked into metadata so
					// future imports on any machine get the same id
					if (skillId !== parsedSkill.id) {
						const updatedMd = serializeSkillMd(skill, instructions);
						await writeFile(join(skillPath, 'SKILL.md'), updatedMd, 'utf-8');
					}

					{
						await using h = openInstructionsDoc(skillId);
						await h.whenReady;
						h.instructions.write(instructions);
					}

					// Import references in parallel
					const refsPath = join(skillPath, 'references');
					const { data: refEntries } = await tryAsync({
						try: () => readdir(refsPath),
						catch: () => Ok(null),
					});
					if (refEntries !== null) {
						const mdFiles = refEntries.filter((f) => f.endsWith('.md'));

						await Promise.all(
							mdFiles.map(async (fileName) => {
								const refContent = await readFile(
									join(refsPath, fileName),
									'utf-8',
								);
								const refId = deriveReferenceId(skillId, fileName);

								tables.references.set({
									id: refId,
									skillId,
									path: fileName,
									updatedAt: Date.now(),
								});

								await using h = openReferenceDoc(refId);
								await h.whenReady;
								h.content.write(refContent);
							}),
						);
					}
				}
			},
		}),
		/**
		 * Serialize workspace table data to agentskills.io-compliant folders.
		 *
		 * One-way publish step. Run this when you want agent runtimes (Codex,
		 * Claude Code, OpenCode) to pick up the latest skill definitions.
		 * Stale directories for deleted skills are cleaned up automatically.
		 */
		export_to_disk: defineMutation({
			description: 'Export all skills to an agentskills.io-compliant directory',
			input: DirInput,
			handler: async ({ dir }) => {
				const skills = tables.skills.scan().rows;
				const skillNames = new Set(skills.map((s) => s.name));

				// Export all skills in parallel
				await Promise.all(
					skills.map(async (skill) => {
						const skillDir = join(dir, skill.name);
						await mkdir(skillDir, { recursive: true });

						await using h = openInstructionsDoc(skill.id);
						await h.whenReady;
						const skillMd = serializeSkillMd(skill, h.instructions.read());
						await writeFile(join(skillDir, 'SKILL.md'), skillMd, 'utf-8');

						// Write references in parallel
						const refs = tables.references
							.scan()
							.rows.filter((r) => r.skillId === skill.id);
						if (refs.length > 0) {
							const refsDir = join(skillDir, 'references');
							await mkdir(refsDir, { recursive: true });

							await Promise.all(
								refs.map(async (ref) => {
									await using h = openReferenceDoc(ref.id);
									await h.whenReady;
									const text = h.content.read();
									await writeFile(join(refsDir, ref.path), text, 'utf-8');
								}),
							);
						}
					}),
				);

				// Clean up stale directories in parallel
				const scanResult = await tryAsync({
					try: () => readdir(dir, { withFileTypes: true }),
					catch: (error) => {
						const isNotFound =
							error instanceof Error &&
							'code' in error &&
							error.code === 'ENOENT';
						if (isNotFound) return Ok([]);
						return SkillsIoError.ScanDirectoryFailed({ dir, cause: error });
					},
				});
				if (scanResult.error) throw scanResult.error;

				const staleDirs = scanResult.data.filter(
					(entry) => entry.isDirectory() && !skillNames.has(entry.name),
				);
				await Promise.all(
					staleDirs.map((entry) =>
						rm(join(dir, entry.name), { recursive: true, force: true }),
					),
				);
			},
		}),
	});

	const actions = { ...readActions, ...nodeActions };

	return {
		ydoc: doc.ydoc,
		tables,
		kv: doc.kv,
		actions,
		[Symbol.dispose]() {
			doc[Symbol.dispose]();
		},
	};
}

const REFERENCE_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Derive a deterministic 10-char ID from `skillId + reference path`.
 *
 * Uses SHA-256, then maps each byte to the same `[a-z0-9]` alphabet
 * used by `generateId()`. Renaming a reference file naturally creates
 * a new ID. The old file is conceptually a different reference.
 */
function deriveReferenceId(skillId: string, path: string): string {
	const hash = createHash('sha256').update(`${skillId}:${path}`).digest();
	let result = '';
	for (let i = 0; i < 10; i++) {
		const byte = hash[i] ?? 0;
		result += REFERENCE_ID_ALPHABET[byte % REFERENCE_ID_ALPHABET.length];
	}
	return result;
}
