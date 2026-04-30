import type { AuthClient } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachYjsFileSystem,
	createFileContentDoc,
	createSqliteIndex,
	type FileId,
} from '@epicenter/filesystem';
import { defineMutation, defineQuery } from '@epicenter/sync';
import {
	attachBroadcastChannel,
	attachIndexedDb,
	attachSync,
	createDisposableCache,
	type DeviceDescriptor,
	toWsUrl,
} from '@epicenter/workspace';
import { Bash } from 'just-bash';
import Type from 'typebox';
import { Ok } from 'wellcrafted/result';
import { openOpensidian as openOpensidianDoc } from './core';

export function openOpensidian({
	auth,
	device,
}: {
	auth: AuthClient;
	device: DeviceDescriptor;
}) {
	const doc = openOpensidianDoc();

	const idb = attachIndexedDb(doc.ydoc);
	attachBroadcastChannel(doc.ydoc);

	const fileContentDocs = createDisposableCache(
		(fileId: FileId) =>
			createFileContentDoc({
				fileId,
				workspaceId: doc.ydoc.guid,
				filesTable: doc.tables.files,
				attachPersistence: (d) => attachIndexedDb(d),
			}),
		{ gcTime: 5_000 },
	);

	const sqliteIndex = createSqliteIndex(fileContentDocs)({ tables: doc.tables }).exports;
	const fs = attachYjsFileSystem(doc.tables.files, fileContentDocs);
	const bash = new Bash({ fs, cwd: '/' });

	const actions = {
		files: {
			search: defineQuery({
				title: 'Search Notes',
				description:
					'Search notes by content using full-text search. Returns matching file paths and content snippets.',
				input: Type.Object({
					query: Type.String({ description: 'The search query string' }),
				}),
				handler: async ({ query }) => Ok(await sqliteIndex.search(query)),
			}),
			read: defineQuery({
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
			list: defineQuery({
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
			write: defineMutation({
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
			create: defineMutation({
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
			delete: defineMutation({
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
			move: defineMutation({
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
			mkdir: defineMutation({
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
		},
		bash: {
			exec: defineMutation({
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
		},
	};

	const sync = attachSync(
		{ ydoc: doc.ydoc, actions },
		{
			url: toWsUrl(`${APP_URLS.API}/workspaces/${doc.ydoc.guid}`),
			waitFor: idb,
			device,
			getToken: async () => auth.getToken(),
		},
	);

	return {
		...doc,
		idb,
		fileContentDocs,
		sqliteIndex,
		fs,
		bash,
		actions,
		sync,
		/**
		 * Resolves when IndexedDB has hydrated the local snapshot — the UI can
		 * render with persisted data. Does NOT gate sync (the WebSocket can
		 * connect at any time, including never if the user is offline).
		 */
		whenReady: idb.whenLoaded,
	};
}
