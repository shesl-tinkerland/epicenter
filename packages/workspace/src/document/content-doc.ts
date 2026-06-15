import * as Y from 'yjs';
import type { DocGuid } from './doc-guid.js';

/**
 * Construct a content-doc `Y.Doc` from a composed {@link DocGuid}.
 *
 * This is the one place a child content document is allocated, and requiring a
 * `DocGuid` (not a bare string) is the point. `new Y.Doc({ guid })` accepts any
 * string, so a raw row id or a random `Guid` would construct silently against
 * the wrong identity, with no error until two docs collided. Threading the
 * composed-guid brand to the constructor turns that mistake into a compile
 * error: the only way to get a `DocGuid` is to mint one with `docGuid` (or a
 * wrapper around it).
 *
 * Owns the one construction policy every content doc shares: `gc: true`. Row
 * metadata lives in the root workspace doc; a content doc holds only the
 * collaborative body, which garbage-collects deleted content like any CRDT.
 * Runtime concerns (persistence, sync, codecs, caching, one-shot reads) are
 * deliberately not here: they diverge per runtime and stay at the call site.
 */
export function createContentDoc(guid: DocGuid): Y.Doc {
	return new Y.Doc({ guid, gc: true });
}
