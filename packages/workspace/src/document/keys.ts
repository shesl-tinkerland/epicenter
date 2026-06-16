/**
 * Y.Doc Array Key Conventions
 *
 * The document API stores data in Y.Arrays with these key patterns:
 * - Tables: `table:{tableName}` (one array per table)
 * - KV: `'kv'` (single array for all settings)
 *
 * These prefixes are reserved. Do not create Y.Doc arrays with keys
 * matching these patterns outside of the document API.
 *
 * Liveness does not live in the Y.Doc. Presence is server-owned: the
 * relay binds `nodeId` to a socket by URL stamp at upgrade, and the
 * client derives `peers.list()` from the relay's `presence` full-list
 * text frame. Cross-node dispatch rides a sibling HTTP endpoint
 * correlated with two WebSocket text frames; no Y.Doc array is reserved
 * for it.
 *
 * @example
 * ```typescript
 * import { KV_KEY, TableKey } from '@epicenter/workspace';
 *
 * const kvArray = ydoc.getArray(KV_KEY);                 // 'kv'
 * const postsArray = ydoc.getArray(TableKey('posts'));    // 'table:posts'
 * ```
 */

/** The KV settings array key. */
export const KV_KEY = 'kv';

/** Key type for the KV settings array. */
export type KvKey = typeof KV_KEY;

/** Key type for table arrays: `table:{tableName}`. */
export type TableKey<T extends string = string> = `table:${T}`;

/**
 * Create a table array key from a table name.
 *
 * The generic preserves the literal type when called with a string literal,
 * enabling precise type inference.
 */
export function TableKey<T extends string>(name: T): TableKey<T> {
	return `table:${name}`;
}
