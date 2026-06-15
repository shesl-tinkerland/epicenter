/**
 * Honeycrisp project mount.
 *
 * `honeycrisp(opts?)` returns the `Mount` that an
 * `epicenter.config.ts` default-exports. Disk paths follow the
 * Epicenter-root layout: the SQLite mirror at `.epicenter/sqlite/<id>.db`
 * (hidden) and the read-only markdown projection under table-named folders in
 * the app root.
 */

import { join } from 'node:path';
import { defineActions, defineWorkspace } from '@epicenter/workspace';
import { defineSessionMount } from '@epicenter/workspace/daemon';
import {
	attachGitAutosave,
	attachMarkdownExport,
	type GitAutosaveConfig,
} from '@epicenter/workspace/document/materializer/markdown';
import { attachBunSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';
import {
	attachMountInfrastructure,
	sqlitePath,
} from '@epicenter/workspace/node';
import { createLogger } from 'wellcrafted/logger';
import { createHoneycrisp } from './honeycrisp.js';

export type HoneycrispMountOptions = {
	git?: GitAutosaveConfig;
	/**
	 * Base URL of the Epicenter cloud API used for sync.
	 * Defaults to `process.env.EPICENTER_API_URL`, falling back to the hosted API.
	 */
	baseURL?: string;
};

export function honeycrisp(opts: HoneycrispMountOptions = {}) {
	return defineSessionMount({
		name: 'honeycrisp',
		open(ctx) {
			const { epicenterRoot, mount } = ctx;
			const baseURL =
				opts.baseURL ||
				process.env.EPICENTER_API_URL ||
				'https://api.epicenter.so';

			const workspace = createHoneycrisp({ keyring: ctx.session.keyring });

			const sqlite = attachBunSqliteMaterializer(workspace, {
				filePath: sqlitePath(epicenterRoot, workspace.ydoc.guid),
				log: createLogger(`${mount}-sqlite`),
			});

			const markdown = attachMarkdownExport(workspace, {
				dir: epicenterRoot,
				tables: { notes: {} },
			});
			if (opts.git) {
				attachGitAutosave({
					ydoc: workspace.ydoc,
					dir: join(epicenterRoot, 'notes'),
					config: opts.git,
				});
			}

			const actions = defineActions({
				...workspace.actions,
				...sqlite.actions,
				...markdown.actions,
			});

			const infrastructure = attachMountInfrastructure(workspace.ydoc, ctx, {
				baseURL,
				actions,
				materializers: [sqlite, markdown],
			});

			return defineWorkspace({
				...workspace,
				...infrastructure,
				markdown,
				actions,
			});
		},
	});
}

export type HoneycrispMount = ReturnType<typeof honeycrisp>;
