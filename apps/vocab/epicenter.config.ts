/**
 * Vocab Epicenter root: the daemon entry `epicenter up` loads.
 *
 * This file is the marker that makes `apps/vocab` an Epicenter root and the
 * one place that names which agent this daemon answers as. The default export is
 * the `Mount` that `vocab()` builds; `openEpicenterRoot` imports it, resolves
 * the durable node id under `.epicenter/`, builds the auth-derived session, and
 * opens the mount.
 *
 * The worker (ADR-0024) is the observe loop the mount runs over the
 * `conversations.messages` transcripts. `agentId: 'vocab-home'` is the
 * designation (ADR-0025): the loop hosts exactly the conversations bound to that
 * catalog agent (`row.agent === selfAgentId`) and answers them over hosted sync,
 * while the browser skips its HTTP kickoff for the same conversations. Bind a
 * conversation to `vocab-home` in the app and this daemon is who answers it.
 *
 * Layout (the mount manages the rest):
 *   epicenter.config.ts   this file
 *   .epicenter/           machine state (gitignored): node id, Yjs persistence
 */

import { asAgentId } from '@epicenter/workspace';
import { vocab } from './mount.js';

export default vocab({ agentId: asAgentId('vocab-home') });
