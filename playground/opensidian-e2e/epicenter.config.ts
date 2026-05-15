/**
 * Opensidian workspace playground: one-way materialization to markdown files
 * and a queryable SQLite mirror with FTS5 full-text search.
 *
 * Syncs the Opensidian workspace from the Epicenter API, persists the workspace
 * Y.Doc to SQLite, materializes each file row as a `.md` on disk with YAML
 * frontmatter (metadata) and markdown body (document content), and mirrors
 * the files table into a queryable SQLite database with FTS5 indexing.
 *
 * Reads auth credentials from the CLI credential store at
 * `~/.epicenter/auth/credentials.json`. Run `epicenter auth login` first.
 *
 * Hosts the `opensidian` route as a full daemon peer: actions, sync,
 * presence, RPC, and disposal. Daemon action paths are relative to `actions`.
 *
 * Usage:
 *   # Run the workspace. Imports this config, which constructs the
 *   # workspace, starting persistence + sync + markdown + SQLite materialization.
 *   # Runs until Ctrl+C.
 *   bun run playground/opensidian-e2e/epicenter.config.ts
 *
 *   # Invoke the markdown_prepare mutation.
 *   epicenter run opensidian.markdown_prepare '{"directory":"./some/dir"}' \
 *     -C playground/opensidian-e2e
 */

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createMachineAuthClient } from '@epicenter/auth/node';
import { fileContentDocGuid } from '@epicenter/filesystem';
import {
	attachEncryption,
	attachTimeline,
	createDisposableCache,
	defineActions,
	defineMutation,
	openCollaboration,
	roomWsUrl,
} from '@epicenter/workspace';
import { defineConfig } from '@epicenter/workspace/daemon';
import { attachMarkdownMaterializer } from '@epicenter/workspace/document/materializer/markdown';
import { attachSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';
import { attachYjsLog, epicenterPaths } from '@epicenter/workspace/node';
import { opensidianTables } from 'opensidian';
import Type from 'typebox';
import * as Y from 'yjs';
import { prepareMarkdownFiles, toSlugFilename } from './markdown-utils';

const SERVER_URL = process.env.EPICENTER_SERVER ?? 'https://api.epicenter.so';
const MARKDOWN_DIR = join(import.meta.dir, 'data');
const MATERIALIZER_DIR = join(import.meta.dir, '.epicenter', 'materializer');
mkdirSync(MATERIALIZER_DIR, { recursive: true });

const WORKSPACE_ID = 'opensidian';
const auth = await createMachineAuthClient();

const ydoc = new Y.Doc({ guid: WORKSPACE_ID, gc: false });
const encryption = attachEncryption(ydoc, {
	encryptionKeys: () => {
		if (auth.state.status === 'signed-out') {
			throw new Error('[opensidian-playground] auth signed-out.');
		}
		return auth.state.unlock.encryptionKeys;
	},
});
const tables = encryption.attachTables(opensidianTables);
const kv = encryption.attachKv({});

const persistence = attachYjsLog(ydoc, {
	filePath: epicenterPaths.persistence(WORKSPACE_ID),
});

/**
 * Per-file content persistence via `attachYjsLog`. Each content Y.Doc writes
 * its own `{guid}.db` under `~/.epicenter/persistence/{workspaceId}/content/`.
 * Survives restarts without relying on sync hydration.
 */
const CONTENT_DIR = join(
	epicenterPaths.home(),
	'persistence',
	WORKSPACE_ID,
	'content',
);
const fileContentDocs = createDisposableCache(
	(fileId: string) => {
		const contentYdoc = new Y.Doc({
			guid: fileContentDocGuid({
				workspaceId: WORKSPACE_ID,
				fileId: fileId as never,
			}),
			gc: false,
		});
		const contentPersistence = attachYjsLog(contentYdoc, {
			filePath: join(CONTENT_DIR, `${contentYdoc.guid}.db`),
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

/**
 * Scan a directory for `.md` files and inject a unique `id` into the YAML
 * frontmatter of any file that doesn't already have one. Errors if duplicate
 * IDs are detected across files.
 */
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
	url: roomWsUrl(SERVER_URL, ydoc.guid),
	openWebSocket: auth.openWebSocket,
	replicaId: 'opensidian-playground-daemon',
	actions,
});

const whenReady = collaboration.whenConnected;

const markdown = attachMarkdownMaterializer(ydoc, {
	dir: MARKDOWN_DIR,
	waitFor: whenReady,
}).table(tables.files, {
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
});

const sqlite = attachSqliteMaterializer(ydoc, {
	db: new Database(join(MATERIALIZER_DIR, 'opensidian.db')),
	waitFor: whenReady,
}).table(tables.files, { fts: ['name'] });

export const opensidian = {
	workspaceId: ydoc.guid,
	whenReady,
	actions,
	collaboration,
	async [Symbol.asyncDispose]() {
		ydoc.destroy();
		await collaboration.whenDisposed;
	},
	// Extras for direct script use, not part of the hosted daemon runtime contract.
	id: WORKSPACE_ID,
	ydoc,
	tables,
	kv,
	encryption,
	persistence,
	fileContentDocs,
	markdown,
	sqlite,
};

export default defineConfig({
	daemon: {
		routes: [{ route: 'opensidian', start: () => opensidian }],
	},
});
