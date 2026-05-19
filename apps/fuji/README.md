# Fuji

Fuji is a local-first CMS for entries with structured metadata and collaborative rich text bodies. It works as a journal, writing archive, lightweight knowledge base, or small portfolio backend.

The browser app is the editing surface. The daemon is the local runtime for scripts, SQLite reads, Markdown files, and cross-device sync.

## How It Loads

Fuji has three construction layers:

```txt
src/lib/session.ts
  createSession({ auth, build })
    |
    v
src/lib/browser.ts
  openFujiBrowser({ owner, installationId, openWebSocket })
    |
    +-- openFujiWorkspace(owner.attachEncryption)
    +-- encrypted local storage
    +-- browser sync
    +-- per-entry rich text document cache

src/lib/workspace.ts
  schema, migrations, actions, shared workspace opener
```

`session.ts` is the only browser singleton. It waits for a signed-in owner, opens Fuji, creates reactive entry state, and disposes everything during HMR or sign-out.

`browser.ts` is browser-only runtime wiring. It attaches encrypted local storage, opens the root sync room, and creates a `createDisposableCache` for entry bodies.

`workspace.ts` is the shared contract. Browser code, daemon code, and scripts all use the same table schema and action registry.

## Data Model

Fuji keeps metadata and content in separate Y.Docs:

```txt
Root doc: epicenter.fuji
  entries table
    id
    title
    subtitle
    type[]
    tags[]
    pinned
    rating
    date
    deletedAt
    createdAt
    updatedAt

Entry content doc: docGuid(epicenter.fuji, entries, <entryId>, content)
  Y.XmlFragment bound to ProseMirror
```

The entries table stays small enough for sidebars, filters, table view, timeline view, trash, and scripts. The rich text body opens only when an entry editor needs it.

That split is the main performance choice. Loading 10,000 entries does not mean loading 10,000 rich text trees.

## Browser Runtime

The browser opens Fuji like this:

```ts
const fuji = openFujiBrowser({
	owner,
	installationId: createInstallationId({ storage: localStorage }),
	openWebSocket: auth.openWebSocket,
});
```

The returned handle includes:

```txt
ydoc              root Y.Doc
tables            encrypted entries table
kv                encrypted key-value store
entryContentDocs  disposable cache of per-entry body docs
collaboration     root sync and action dispatch
wipe()            forget local encrypted data for this owner
```

UI code reads the signed-in handle through `requireFuji()` from `$lib/session`.

## Daemon Runtime

The package exports a daemon module at `@epicenter/fuji/daemon`. A project can register Fuji by creating this file:

```txt
<project>/
  workspaces/
    fuji/
      daemon.ts
```

```ts
export { default } from '@epicenter/fuji/daemon';
```

Then start the local daemon from the project root:

```bash
bun run cli daemon up
```

The daemon scans `workspaces/*/daemon.ts`. The folder name becomes the route, so the example above exposes Fuji actions under the `fuji` route.

`.epicenter/` is not where the daemon is registered. It is where the daemon writes runtime state:

```txt
<project>/
  .epicenter/
    sqlite/       queryable materialized tables
    yjs/          local Y.Doc update log
    markdown/     generated Markdown files
    daemon.sock   local IPC socket
```

Fuji's daemon does four things:

```txt
openFujiWorkspace(...)
  |
  +-- attachDaemonInfrastructure(...)
  |     writes the Yjs log
  |     opens sync
  |     exposes daemon actions
  |
  +-- attachSqliteMaterializer(...)
  |     mirrors entries into SQLite
  |
  +-- attachMarkdownMaterializer(...)
        writes entry Markdown files
```

The actual daemon entrypoint is small:

```ts
import { defineDaemonWorkspace } from '@epicenter/workspace/daemon';
import {
	attachMarkdownMaterializer,
	slugFilename,
} from '@epicenter/workspace/document/materializer/markdown';
import { attachSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';
import {
	attachDaemonInfrastructure,
	markdownPath,
	openWriterSqlite,
	sqlitePath,
} from '@epicenter/workspace/node';
import { createLogger } from 'wellcrafted/logger';
import { openFujiWorkspace } from '@epicenter/fuji/workspace';

export default defineDaemonWorkspace({
	async open({
		projectDir,
		route,
		clientId,
		installationId,
		attachEncryption,
		openWebSocket,
	}) {
		const workspace = openFujiWorkspace(attachEncryption, { clientId });

		const infra = attachDaemonInfrastructure(workspace.ydoc, {
			projectDir,
			openWebSocket,
			installationId,
			actions: workspace.actions,
		});

		const sqliteDb = openWriterSqlite({
			filePath: sqlitePath(projectDir, workspace.ydoc.guid),
			log: createLogger(`${route}-sqlite`),
		});
		workspace.ydoc.once('destroy', () => sqliteDb.close());

		attachSqliteMaterializer(workspace.ydoc, { db: sqliteDb }).table(
			workspace.tables.entries,
		);

		attachMarkdownMaterializer(workspace.ydoc, {
			dir: markdownPath(projectDir, workspace.ydoc.guid),
		}).table(workspace.tables.entries, { filename: slugFilename('title') });

		return infra;
	},
});
```

Most projects should not copy that whole file. Use the one-line re-export unless you need to customize materializers.

## Scripts

Scripts read from SQLite and write through daemon actions:

```ts
import { connectDaemonActions } from '@epicenter/workspace';
import { findEpicenterDir, openWorkspaceSqlite } from '@epicenter/workspace/node';
import { FUJI_WORKSPACE_ID, type FujiActions } from '@epicenter/fuji';

const projectDir = findEpicenterDir();

const db = openWorkspaceSqlite(projectDir, FUJI_WORKSPACE_ID);
const rows = db.query('SELECT * FROM entries').all();

const fuji = await connectDaemonActions<FujiActions>({
	route: 'fuji',
	projectDir,
});

await fuji.entries_create({ title: `Imported ${rows.length} rows` });
db.close();
```

Reads do not require a running daemon. Writes do, because the daemon is the single writer for the live Y.Doc.

## Development

```bash
bun install
bun run --cwd apps/fuji dev
```

Auth and sync expect the local API on `localhost:8787`:

```bash
bun run dev:api
```

Useful checks:

```bash
bun test apps/fuji
bun run --cwd apps/fuji typecheck
bun run --cwd apps/fuji build
```

## Package Exports

```txt
@epicenter/fuji            shared workspace contract
@epicenter/fuji/workspace  shared workspace contract
@epicenter/fuji/browser    browser runtime factory
@epicenter/fuji/daemon     daemon module for workspaces/<route>/daemon.ts
```
