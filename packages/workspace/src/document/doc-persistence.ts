/**
 * Consumer contract for `attachPersistence` callbacks on per-row document
 * factories (`createFileContentDocs`, `createSkillInstructionsDocs`,
 * `createReferenceContentDocs`, and similar app-level wrappers).
 *
 * Both fields are required — every real persistence attachment signals
 * initial-load readiness and final teardown, and requiring them here catches
 * missing providers at the callback's definition site instead of at runtime.
 * Attachments without async teardown can set `whenDisposed: Promise.resolve()`.
 *
 * This is a *consumer contract*, not a produced attachment — there is no
 * `attachPersistence()` function. Real producers (`attachIndexedDb`,
 * `attachSqlitePersistence`) return richer types that structurally satisfy this shape.
 */
export type DocPersistence = {
	whenLoaded: Promise<unknown>;
	whenDisposed: Promise<unknown>;
};
