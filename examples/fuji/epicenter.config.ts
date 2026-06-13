/**
 * Canonical Epicenter folder: one mount, declared at the root.
 *
 * Layout (per specs/20260612T000201-epicenter-namespace-root-layout.md):
 *   epicenter.config.ts            this file: marker + mount factory call
 *   fuji/                          markdown projection (committed)
 *   .epicenter/                    machine state (gitignored)
 *     yjs/<id>.db                  Yjs persistence, keyed by ydoc.guid
 *     sqlite/<id>.db               SQL materializer, keyed by ydoc.guid
 *
 * `fuji()` returns a Mount named `fuji`, so `Mount.name` owns the CLI prefix:
 * `fuji.<action_key>` regardless of the folder name. The markdown projection
 * lands at `<epicenterRoot>/fuji/` (a direct child of this folder), and the
 * SQLite mirror is guid-keyed under `.epicenter/sqlite/<id>.db`.
 */

import { fuji } from '@epicenter/fuji/project';

export default fuji();
