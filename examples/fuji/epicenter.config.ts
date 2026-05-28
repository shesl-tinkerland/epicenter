/**
 * Canonical Epicenter project: one mount, declared at the root.
 *
 * Layout (per specs/20260522T220000-workspace-project-layout.md):
 *   epicenter.config.ts       this file: marker + mount factory call
 *   entries/                  table data as markdown (committed)
 *   .epicenter/               runtime cache (gitignored)
 *     yjs.db                  Yjs persistence
 *     sqlite.db               SQL materializer
 *
 * The `fuji()` factory carries its own canonical mount name (`fuji`), so the
 * CLI addresses actions as `fuji.<action_key>` regardless of the project
 * folder name. Options below pull the markdown projection up to the project
 * root and inline the SQLite file under `.epicenter/`.
 */

import { fuji } from '@epicenter/fuji/project';

export default fuji({
	markdownDir: '.',
	sqliteFile: '.epicenter/sqlite.db',
});
