/**
 * Tab Manager RPC Contract — type-only export for cross-device calls.
 *
 * Import this type in other apps (CLI, desktop, etc.) to get type-safe
 * RPC calls against the tab-manager's actions. Zero runtime cost.
 *
 * @example
 * ```typescript
 * import type { TabManagerRpc } from '@epicenter/tab-manager/rpc';
 *
 * const { data, error } = await workspace.sync.rpc<TabManagerRpc>(
 *   peer.clientId, 'tabs.close', { tabIds: [1, 2, 3] },
 * );
 * // data is { closedCount: number } | null — fully inferred
 * ```
 */
import type { InferRpcMap } from '@epicenter/sync';
import type { tabManager } from '../tab-manager/client';

type Actions = typeof tabManager.actions;

export type TabManagerRpc = InferRpcMap<Actions>;
