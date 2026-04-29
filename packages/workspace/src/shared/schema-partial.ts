/**
 * `partialUpdate(schema)` — derive an arktype schema for table update inputs.
 *
 * Builds `{ id, ...Partial<Rest> }`: the `id` field stays required, every
 * other column becomes optional. Used as the input shape for an auto-generated
 * `update(...)` action (see `daemon/table-actions.ts`).
 *
 * ## Implementation
 *
 *   schema.pick('id').and(schema.omit('id').partial())
 *
 * arktype preserves morph brands across this composition: `pick` carries the
 * `.pipe(...)` morph through unchanged, and `.and()` merges property morphs
 * without erasing them. Branded ids like `EntryId` survive on the inferred
 * input type, and runtime validation still rejects malformed optional fields.
 *
 * @example
 * ```ts
 * import { type } from 'arktype';
 *
 * const Entry = type({ id: 'string', title: 'string', _v: '"1"' });
 * const Patch = partialUpdate(Entry);
 *
 * Patch({ id: 'x' });             // ok
 * Patch({ id: 'x', title: 'a' }); // ok
 * Patch({ title: 'no id' });      // errors (id required)
 * Patch({ id: 'x', _v: 99 });     // errors (literal mismatch)
 * ```
 */
import type { Type, type } from 'arktype';

/**
 * Inferred input shape: `id` required, rest optional. Brands and morphs on
 * `id` survive because arktype's `.pick` / `.and` preserve them.
 */
type PartialUpdate<S extends type.Any> = Type<
	Pick<S['infer'], 'id'> & Partial<Omit<S['infer'], 'id'>>,
	S['t'] extends { $: infer Scope } ? Scope : {}
>;

export function partialUpdate<S extends type.Any & { infer: { id: unknown } }>(
	schema: S,
): PartialUpdate<S> {
	// biome-ignore lint/suspicious/noExplicitAny: arktype's pick/omit overloads
	// require literal-string args; the runtime call is correct, the cast only
	// silences variadic-signature mismatch. PartialUpdate<S> reconstructs the
	// brand-preserving inferred type.
	const anySchema = schema as any;
	const required = anySchema.pick('id');
	const rest = anySchema.omit('id').partial();
	return required.and(rest) as PartialUpdate<S>;
}
