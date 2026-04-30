/**
 * `@epicenter/workspace/core`: generic primitives that don't reach into Yjs.
 *
 * What lives here:
 * - Path brands (`AbsolutePath`, `ProjectDir`)
 * - ID and GUID utilities (`Id`, `Guid`, `generateId`, `generateGuid`)
 * - `DateTimeString` (timezone-aware timestamp brand + companion object)
 * - Device identity helpers (`getOrCreateDeviceId`, storage adapters)
 * - `createDisposableCache` (refcounted resource cache)
 * - Misc utility types (`MaybePromise`, `Simplify`)
 *
 * Importing from this subpath signals that the consumer doesn't depend on
 * Yjs, the workspace document API, or any sync wiring: only the shared
 * primitives. The day someone wants these without pulling Yjs into their
 * tree, this folder lifts cleanly to its own package.
 *
 * The root barrel (`@epicenter/workspace`) still re-exports these for
 * back-compat, so existing app imports do not need to change.
 */

// ---- Utility types --------------------------------------------------------

export type { MaybePromise, Simplify } from '../shared/types.js';

// ---- Filesystem path brands -----------------------------------------------

export type { AbsolutePath, ProjectDir } from '../shared/types.js';

// ---- IDs ------------------------------------------------------------------

export type { Guid, Id } from '../shared/id.js';
export { Id as createId, generateGuid, generateId } from '../shared/id.js';

// ---- Date / time ----------------------------------------------------------

export type {
	DateIsoString,
	ParsedDateTimeString,
	TimezoneId,
} from '../shared/datetime-string.js';
export { DateTimeString } from '../shared/datetime-string.js';

// ---- Device identity ------------------------------------------------------

export {
	type AsyncStorage,
	getOrCreateDeviceId,
	getOrCreateDeviceIdAsync,
	type SimpleStorage,
} from '../shared/device-id.js';

// ---- Refcounted disposable cache ------------------------------------------

export {
	createDisposableCache,
	type DisposableCache,
	DisposableCacheError,
} from '../cache/disposable-cache.js';
