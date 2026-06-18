/**
 * Zhongwen Epicenter root: the daemon entry `epicenter up` loads.
 *
 * This file is the marker that makes `apps/zhongwen` an Epicenter root and the
 * one place that names which agent this daemon answers as. The default export is
 * the `Mount` that `zhongwen()` builds; `openEpicenterRoot` imports it, resolves
 * the durable node id under `.epicenter/`, builds the auth-derived session, and
 * opens the mount.
 *
 * The actor (ADR-0014) is the observe loop the mount runs over the
 * `conversations.messages` transcripts. `agentId: 'zhongwen-home'` is the
 * designation (ADR-0015): the loop hosts exactly the conversations bound to that
 * catalog agent (`row.agent === selfAgentId`) and answers them over hosted sync,
 * while the browser skips its HTTP kickoff for the same conversations. Bind a
 * conversation to `zhongwen-home` in the app and this daemon is who answers it.
 *
 * Layout (the mount manages the rest):
 *   epicenter.config.ts   this file
 *   .epicenter/           machine state (gitignored): node id, Yjs persistence
 */

import { asAgentId } from '@epicenter/workspace';
import { zhongwen } from './mount.js';

export default zhongwen({ agentId: asAgentId('zhongwen-home') });
