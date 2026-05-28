/**
 * Opensidian workspace playground: markdown and SQLite materializers around
 * the mount contract.
 *
 * Run with:
 *
 * ```bash
 * epicenter daemon up -C playground/opensidian-e2e
 * ```
 */

import type { FileId } from '@epicenter/filesystem';
import {
	attachTimeline,
	createDisposableCache,
	defineActions,
	defineMutation,
	openCollaboration,
	roomWsUrl,
} from '@epicenter/workspace';
import { defineMount, type MountContext } from '@epicenter/workspace/daemon';
import { attachMarkdownMaterializer } from '@epicenter/workspace/document/materializer/markdown';
import { attachBunSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';
import { toSlugFilename } from '@epicenter/workspace/markdown';
import {
	attachYjsLog,
	markdownPath,
	sqlitePath,
	yjsPath,
} from '@epicenter/workspace/node';
import {
	createOpensidianWorkspace,
	opensidianFileContentDocGuid,
} from 'opensidian';
import Type from 'typebox';
import * as Y from 'yjs';
import { prepareMarkdownFiles } from '../../prepare-markdown-files';

const SERVER_URL = process.env.EPICENTER_API_URL ?? 'https://api.epicenter.so';

async function openOpensidianPlayground({
	projectDir,
	yDocClientId,
	deviceId,
	ownerId,
	keyring,
	openWebSocket,
	onReconnectSignal,
}: MountContext) {
	const workspace = createOpensidianWorkspace({ keyring });
	workspace.ydoc.clientID = yDocClientId;
	const { ydoc, tables, kv } = workspace;
	const workspaceId = ydoc.guid;

	const persistence = attachYjsLog(ydoc, {
		filePath: yjsPath(projectDir, workspaceId),
	});

	const fileContentDocs = createDisposableCache(
		(fileId: string) => {
			const contentYdoc = new Y.Doc({
				guid: opensidianFileContentDocGuid(fileId as FileId),
				gc: true,
			});
			const contentPersistence = attachYjsLog(contentYdoc, {
				filePath: yjsPath(projectDir, contentYdoc.guid),
			});
			return {
				ydoc: contentYdoc,
				content: attachTimeline(contentYdoc),
				persistence: contentPersistence,
				[Symbol.dispose]() {
					contentYdoc.destroy();
				},
			};
		},
		{ gcTime: 5_000 },
	);

	async function readContent(rowId: string): Promise<string | undefined> {
		await using handle = fileContentDocs.open(rowId);
		return handle.content.read();
	}

	const actions = defineActions({
		markdown_prepare: defineMutation({
			title: 'Prepare Markdown Files',
			description:
				'Add unique IDs to markdown files missing them in YAML frontmatter',
			input: Type.Object({ directory: Type.String() }),
			handler: async ({ directory }) => prepareMarkdownFiles(directory),
		}),
	});

	const collaboration = openCollaboration(ydoc, {
		url: roomWsUrl({
			baseURL: SERVER_URL,
			ownerId,
			guid: ydoc.guid,
			deviceId,
		}),
		openWebSocket,
		onReconnectSignal,
		actions,
	});

	const whenReady = collaboration.whenConnected;
	const markdown = attachMarkdownMaterializer(workspace, {
		dir: markdownPath(projectDir, workspaceId),
		waitFor: whenReady,
		perTable: {
			files: {
				filename: (row) =>
					row.type === 'folder'
						? `${row.id}.md`
						: toSlugFilename(row.name.replace(/\.md$/i, ''), row.id),
				toMarkdown: async (row) => {
					if (row.type === 'folder') {
						return {
							frontmatter: { id: row.id, name: row.name, type: 'folder' },
							body: undefined,
						};
					}
					let body: string | undefined;
					try {
						body = await readContent(row.id);
					} catch {
						// Content doc not yet available (sync pending).
					}
					return {
						frontmatter: {
							id: row.id,
							name: row.name,
							parentId: row.parentId,
							size: row.size,
							createdAt: row.createdAt,
							updatedAt: row.updatedAt,
							trashedAt: row.trashedAt,
						},
						body,
					};
				},
			},
		},
	});

	const sqlite = attachBunSqliteMaterializer(workspace, {
		filePath: sqlitePath(projectDir, workspaceId),
		waitFor: whenReady,
		fts: { files: ['name'] },
	});

	return {
		workspaceId: ydoc.guid,
		whenReady,
		actions,
		collaboration,
		async [Symbol.asyncDispose]() {
			fileContentDocs[Symbol.dispose]();
			ydoc.destroy();
			await collaboration.whenDisposed;
		},
		ydoc,
		tables,
		kv,
		persistence,
		fileContentDocs,
		markdown,
		sqlite,
	};
}

export type OpensidianPlaygroundRuntime = Awaited<
	ReturnType<typeof openOpensidianPlayground>
>;

export default defineMount({
	name: 'opensidian',
	open: openOpensidianPlayground,
});
