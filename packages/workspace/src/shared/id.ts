/**
 * @fileoverview Id/Guid brands and the collision-only id generator.
 *
 * Every id we mint ourselves is the same kind of thing: a public,
 * collision-resistant identifier. It is never an access-control secret.
 * Room/document access is gated server-side by authentication + ownership
 * partition (see `@epicenter/server`'s require-ownership middleware), so
 * knowing an id grants nothing. Per OWASP's IDOR guidance, an
 * unguessable id is at most defense-in-depth, never the access boundary.
 *
 * Because the property is the same everywhere, there is one generator,
 * {@link generateId}. Callers brand its output to taste (`Id`, `Guid`,
 * `NodeId`, `FileId`, ...); the brand is the semantics, the generator
 * is the mechanism, and they are deliberately decoupled.
 *
 * The one genuine *secret* in the system, the public-asset URL token, is
 * generated separately in `@epicenter/server` (see `assets.ts`): it needs
 * unguessability rather than mere collision resistance, and lives in the
 * Worker bundle.
 */

import { customAlphabet } from 'nanoid';
import type { Brand } from 'wellcrafted/brand';

/**
 * Lowercase alphanumeric, 36 symbols (~5.17 bits/char). Chosen for
 * ergonomics, not security: case-insensitive-safe in URLs, filenames, and
 * logs, clean across the `:` cell-key separator, and double-click
 * selectable. Entropy comes from {@link ID_LENGTH}, not the alphabet.
 */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * 16 chars over {@link ALPHABET} = ~82.7 bits. Sized for the largest
 * population we mint: rows in a *shared-mode* workspace, where every
 * admitted user's rows pool into one table. At 100M such rows the chance
 * of any collision is ~1-in-1.6-billion; even at 1B rows it is ~1-in-16M.
 * This is the minimum length that stays safe at that scale, which matters
 * because each id is a CRDT map key (longer = more bytes per row synced).
 */
const ID_LENGTH = 16;

const nanoid = customAlphabet(ALPHABET, ID_LENGTH);

/**
 * Branded string for a table row identifier.
 *
 * Only needs to be unique within a single table. The default brand for
 * {@link generateId}.
 */
export type Id = string & Brand<'Id'>;

/**
 * Create a branded Id from an arbitrary string.
 *
 * Validates that the string does not contain ':' (reserved for cell-key separator).
 * Use this when you have a string ID that needs to be used as a row identifier.
 *
 * @param value - The string to brand as an Id
 * @returns A branded Id
 * @throws If the value contains ':'
 *
 * @example
 * ```typescript
 * const id = Id('my-custom-id');
 * const generated = generateId(); // Also returns Id
 * ```
 */
export function Id(value: string): Id {
	if (value.includes(':')) {
		throw new Error(`Id cannot contain ':': "${value}"`);
	}
	return value as Id;
}

/**
 * Branded string for a broader-scope identifier: workspace ids, derived
 * child-doc guids, node ids, file ids.
 *
 * Same mechanism as {@link Id} (a collision-only public nanoid); the
 * distinct brand only documents that the value identifies something
 * beyond a single table row. Most `Guid` values are not produced by
 * {@link generateId} at all: workspace ids are app-chosen strings and
 * child-doc guids are derived (workspace id + table + row id + field).
 */
export type Guid = string & Brand<'Guid'>;

/**
 * Generate a collision-only public identifier (16-char lowercase nanoid,
 * ~82.7 bits, CSPRNG-backed via `nanoid`).
 *
 * This is the single id generator. Brand the result for the call site:
 * `generateId<Guid>()`, `generateId<NodeId>()`, etc. It is not a secret;
 * see the file overview for why access control is a separate layer.
 *
 * @returns A unique identifier, branded as {@link Id} by default.
 * @example
 * ```typescript
 * const rowId = generateId();              // Id
 * const nodeId = generateId<NodeId>(); // NodeId
 * ```
 */
export function generateId<T extends string = Id>(): T {
	return nanoid() as T;
}
