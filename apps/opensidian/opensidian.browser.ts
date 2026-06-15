/**
 * Opensidian browser composition.
 *
 * Single source of truth for "how Opensidian mounts in a browser." Calls
 * Tier 1 primitives inline so every line is visible top-to-bottom:
 *
 *  1. workspace root doc (encrypted tables + KV via createOpensidian)
 *  2. local storage + cloud sync for root (attachLocalStorage + openCollaboration)
 *  3. runtime storage + sync around the shared per-file child docs
 *  4. file system, sqlite index, bash, and action registry
 *  5. wipe / dispose teardown
 *
 * `openCollaboration` owns reconnect-on-auth-change internally, so this file
 * has no per-app onStateChange listener.
 *
 * The bundle's `wipe()` drops every encrypted IDB database for this owner;
 * `Symbol.dispose` tears down the root + cached child Y.Docs without touching
 * local storage.
 */

import {
	attachYjsFileSystem,
	createSqliteIndex,
	type FileId,
} from '@epicenter/filesystem';
import type { SignedIn } from '@epicenter/svelte/auth';
import {
	attachLocalStorage,
	createDisposableCache,
	type DeviceId,
	defineActions,
	defineMutation,
	defineQuery,
	defineWorkspace,
	openCollaboration,
	roomWsUrl,
	wipeLocalStorage,
} from '@epicenter/workspace';
import { Bash } from 'just-bash';
import Type from 'typebox';
import { Ok } from 'wellcrafted/result';
import { createOpensidian } from './opensidian';

export function openOpensidianBrowser({
	signedIn,
	deviceId,
}: {
	signedIn: SignedIn;
	deviceId: DeviceId;
}) {
	const workspace = createOpensidian({ keyring: signedIn.keyring });
	const { ydoc, tables } = workspace;

	const idb = attachLocalStorage(ydoc, {
		server: signedIn.server,
		ownerId: signedIn.ownerId,
		keyring: signedIn.keyring,
	});

	const fileContentDocs = createDisposableCache((fileId: FileId) => {
		const contentDoc = workspace.fileContentDocs.open(fileId);
		const childIdb = attachLocalStorage(contentDoc.ydoc, {
			server: signedIn.server,
			ownerId: signedIn.ownerId,
			keyring: signedIn.keyring,
		});
		// File bodies sync through Cloud so device loss doesn't drop the largest
		// data class.
		const childSync = openCollaboration(contentDoc.ydoc, {
			url: roomWsUrl({
				baseURL: signedIn.baseURL,
				ownerId: signedIn.ownerId,
				guid: contentDoc.ydoc.guid,
				deviceId,
			}),
			openWebSocket: signedIn.openWebSocket,
			onReconnectSignal: signedIn.onReconnectSignal,
			waitFor: childIdb.whenLoaded,
			actions: {},
		});
		return {
			...contentDoc,
			idb: childIdb,
			sync: childSync,
			/**
			 * Child disposer rejections do not propagate; bundle.wipe() relies on
			 * IDB's deleteDatabase native blocking as belt-and-suspenders for
			 * storage deletion.
			 */
			[Symbol.dispose]() {
				contentDoc[Symbol.dispose]();
			},
		};
	});
	const fileContent = {
		async read(fileId: FileId) {
			await using handle = fileContentDocs.open(fileId);
			await handle.idb.whenLoaded;
			return handle.content.read();
		},
		async write(fileId: FileId, text: string) {
			await using handle = fileContentDocs.open(fileId);
			await handle.idb.whenLoaded;
			handle.content.write(text);
		},
		async append(fileId: FileId, text: string) {
			await using handle = fileContentDocs.open(fileId);
			await handle.idb.whenLoaded;
			handle.content.appendText(text);
			return handle.content.read();
		},
	};
	const fs = attachYjsFileSystem(ydoc, tables.files, fileContent);
	const sqliteIndex = createSqliteIndex({
		readContent: fileContent.read,
		index: fs.index,
	})({
		tables,
	});
	const sqliteIndexExports = sqliteIndex.exports;
	const bash = new Bash({ fs, cwd: '/' });
	const actions = defineActions({
		...workspace.actions,
		files_search: defineQuery({
			title: 'Search Notes',
			description:
				'Search notes by content using full-text search. Returns matching file paths and content snippets.',
			input: Type.Object({
				query: Type.String({ description: 'The search query string' }),
			}),
			handler: async ({ query }) => Ok(await sqliteIndexExports.search(query)),
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

	const collaboration = openCollaboration(ydoc, {
		url: roomWsUrl({
			baseURL: signedIn.baseURL,
			ownerId: signedIn.ownerId,
			guid: ydoc.guid,
			deviceId,
		}),
		openWebSocket: signedIn.openWebSocket,
		onReconnectSignal: signedIn.onReconnectSignal,
		waitFor: idb.whenLoaded,
		actions,
	});

	let docsTornDown = false;

	function teardownDocs() {
		if (docsTornDown) return;
		docsTornDown = true;
		fileContentDocs[Symbol.dispose]();
		sqliteIndex[Symbol.dispose]();
		workspace[Symbol.dispose]();
	}

	return defineWorkspace({
		...workspace,
		idb,
		fileContentDocs,
		sqliteIndex: sqliteIndexExports,
		fs,
		bash,
		actions,
		collaboration,
		async wipe() {
			teardownDocs();
			await Promise.all([idb.whenDisposed, collaboration.whenDisposed]);
			await wipeLocalStorage({
				server: signedIn.server,
				ownerId: signedIn.ownerId,
			});
		},
		[Symbol.dispose]() {
			teardownDocs();
		},
	});
}

export type OpensidianBrowser = ReturnType<typeof openOpensidianBrowser>;
export type OpensidianActions = OpensidianBrowser['actions'];
