import type { SqliteIndex, YjsFileSystem } from '@epicenter/filesystem';
import {
	defineActions,
	defineMutation,
	defineQuery,
} from '@epicenter/workspace';
import type { Bash } from 'just-bash';
import Type from 'typebox';
import { Ok } from 'wellcrafted/result';

export function createOpensidianActions({
	fs,
	sqliteIndex,
	bash,
}: {
	fs: YjsFileSystem;
	sqliteIndex: SqliteIndex['exports'];
	bash: Bash;
}) {
	return defineActions({
		files_search: defineQuery({
			title: 'Search Notes',
			description:
				'Search notes by content using full-text search. Returns matching file paths and content snippets.',
			input: Type.Object({
				query: Type.String({ description: 'The search query string' }),
			}),
			handler: async ({ query }) => Ok(await sqliteIndex.search(query)),
		}),
		files_read: defineQuery({
			title: 'Read File',
			description:
				'Read the full content of a file by its absolute path (e.g. "/notes/meeting.md").',
			input: Type.Object({
				path: Type.String({
					description: 'Absolute file path starting with /',
				}),
			}),
			handler: async ({ path }) => {
				const content = await fs.readFile(path);
				const MAX_LENGTH = 50_000;
				if (content.length > MAX_LENGTH) {
					return Ok({
						content: content.slice(0, MAX_LENGTH),
						truncated: true,
						totalLength: content.length,
						note: `Content truncated at ${MAX_LENGTH} chars. Use bash head/tail for specific sections.`,
					});
				}
				return Ok({ content, truncated: false });
			},
		}),
		files_list: defineQuery({
			title: 'List Directory',
			description:
				'List files and folders in a directory. Use "/" for the root.',
			input: Type.Object({
				path: Type.Optional(
					Type.String({ description: 'Directory path. Defaults to "/"' }),
				),
			}),
			handler: async ({ path }) => {
				const entries = await fs.readdir(path ?? '/');
				return Ok({ entries });
			},
		}),
		files_write: defineMutation({
			title: 'Write File',
			description:
				'Write content to a file. Creates the file if it does not exist, overwrites if it does.',
			input: Type.Object({
				path: Type.String({ description: 'Absolute file path' }),
				content: Type.String({ description: 'The content to write' }),
			}),
			handler: async ({ path, content }) => {
				await fs.writeFile(path, content);
				return Ok({ success: true, path });
			},
		}),
		files_create: defineMutation({
			title: 'Create File',
			description: 'Create a new empty file at the given path.',
			input: Type.Object({
				path: Type.String({
					description: 'Absolute file path for the new file',
				}),
			}),
			handler: async ({ path }) => {
				await fs.writeFile(path, '');
				return Ok({ success: true, path });
			},
		}),
		files_delete: defineMutation({
			title: 'Delete File',
			description: 'Delete a file or directory at the given path.',
			input: Type.Object({
				path: Type.String({ description: 'Absolute path to delete' }),
			}),
			handler: async ({ path }) => {
				await fs.rm(path);
				return Ok({ success: true, path });
			},
		}),
		files_move: defineMutation({
			title: 'Move/Rename File',
			description: 'Move or rename a file from one path to another.',
			input: Type.Object({
				src: Type.String({ description: 'Current file path' }),
				dst: Type.String({ description: 'New file path' }),
			}),
			handler: async ({ src, dst }) => {
				await fs.mv(src, dst);
				return Ok({ success: true, from: src, to: dst });
			},
		}),
		files_mkdir: defineMutation({
			title: 'Create Directory',
			description: 'Create a new directory at the given path.',
			input: Type.Object({
				path: Type.String({ description: 'Absolute directory path' }),
			}),
			handler: async ({ path }) => {
				await fs.mkdir(path);
				return Ok({ success: true, path });
			},
		}),
		bash_exec: defineMutation({
			title: 'Execute Bash Command',
			description:
				'Execute a bash command against the virtual filesystem. Supports standard Unix commands (ls, cat, grep, echo, etc.).',
			input: Type.Object({
				command: Type.String({
					description: 'The bash command to execute',
				}),
			}),
			handler: async ({ command }) => {
				const result = await bash.exec(command);
				return Ok({
					stdout: result.stdout,
					stderr: result.stderr,
					exitCode: result.exitCode,
				});
			},
		}),
	});
}

export type OpensidianActions = ReturnType<typeof createOpensidianActions>;
