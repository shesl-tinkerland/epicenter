/**
 * Consumer contract for `attachPersistence` callbacks on per-row document
 * factories (`createFileContentDocs`, `createSkillInstructionsDocs`,
 * `createReferenceContentDocs`, and similar app-level wrappers).
 *
 * `whenDisposed` is required: every persistence has a teardown signal.
 * `whenLoaded` is optional because some producers construct synchronously
 * and have nothing to await. `attachIndexedDb` (browser, IDB is async)
 * provides it; `attachYjsLog` (node/bun, sync construction) does not.
 * Consumers that want a unified "ready" signal can read
 * `persistence?.whenLoaded` and treat `undefined` as "ready now."
 *
 * This is a *consumer contract*, not a produced attachment: there is no
 * `attachPersistence()` function. Real producers (`attachIndexedDb`,
 * `attachYjsLog`) return richer types that structurally satisfy this shape.
 */
export type DocPersistence = {
	whenLoaded?: Promise<unknown>;
	whenDisposed: Promise<unknown>;
};
