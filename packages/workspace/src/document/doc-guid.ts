import type { Brand } from 'wellcrafted/brand';
import { assertSafeSegment, isSafeSegment } from '../shared/safe-segment.js';

/**
 * A composed content-doc guid: the dotted string returned by {@link docGuid}
 * (`workspaceId.collection.rowId.field`).
 *
 * A distinct brand from `Guid`. A `Guid` is a single random token (one safe
 * segment, e.g. `generateGuid()`); a `DocGuid` is a deterministic four-segment
 * composition. They obey different grammars, so they are not interchangeable
 * even though both end up as `ydoc.guid`. Keeping the brands apart stops a
 * random `Guid` being passed where a composed `DocGuid` is required, and the
 * reverse.
 */
export type DocGuid = string & Brand<'DocGuid'>;

/** Number of dot-separated segments in every {@link DocGuid}. */
export const DOC_GUID_SEGMENTS = 4;

/**
 * Compose a content-doc `Y.Doc` guid in the canonical 4-part dotted form:
 *
 *   `${workspaceId}.${collection}.${rowId}.${field}`
 *
 * | Segment       | Owner       | Example          |
 * |---------------|-------------|------------------|
 * | `workspaceId` | caller      | `epicenter-fuji` |
 * | `collection`  | package/app | `entries`, `files` |
 * | `rowId`       | caller      | `k7x9m2p4q8`     |
 * | `field`       | package/app | `content`, `body` |
 *
 * The `field` segment names which child document of the row this guid points
 * at. Most collections own exactly one child doc today (`notes -> body`,
 * `files -> content`), so `field` looks redundant there. It is kept anyway: it
 * is the segment that lets a single row own more than one sibling child doc
 * (e.g. an article with a `code` doc and a `preview` doc) without the two guids
 * colliding. Dropping it would make injectivity rest on the unenforced
 * convention "one child doc per row", and a second child doc would then merge
 * silently into the first. One cheap segment buys a structural guarantee.
 *
 * Every part is validated against {@link assertSafeSegment}, so each is a
 * single dot-free safe segment. That is what makes this composition injective:
 * because `collection`, `rowId`, and `field` contain no dots, the three
 * trailing segments are recoverable from the right, and no two distinct
 * `(workspaceId, collection, rowId, field)` tuples can ever produce the same
 * guid. A collision here would merge two Y.Docs, so the guarantee is load
 * bearing, not cosmetic.
 *
 * Using this helper (instead of inline template literals) keeps the grammar
 * in one place and the validation impossible to forget.
 */
export const docGuid = ({
	workspaceId,
	collection,
	rowId,
	field,
}: {
	workspaceId: string;
	collection: string;
	rowId: string;
	field: string;
}): DocGuid => {
	assertSafeSegment(workspaceId, 'workspaceId');
	assertSafeSegment(collection, 'collection');
	assertSafeSegment(rowId, 'rowId');
	assertSafeSegment(field, 'field');
	return `${workspaceId}.${collection}.${rowId}.${field}` as DocGuid;
};

/**
 * True when `value` is a well-formed {@link DocGuid}: exactly
 * {@link DOC_GUID_SEGMENTS} dot-separated safe segments.
 *
 * Derives from the same segment grammar `docGuid` mints with, so a validator
 * and a minter can never disagree. Use at trust boundaries (e.g. a server
 * reading a guid off the wire) where the structured tuple is not in hand to
 * re-mint from. Everywhere else, build the guid with {@link docGuid} rather
 * than validating a string.
 */
export function isDocGuid(value: string): value is DocGuid {
	const segments = value.split('.');
	return segments.length === DOC_GUID_SEGMENTS && segments.every(isSafeSegment);
}
