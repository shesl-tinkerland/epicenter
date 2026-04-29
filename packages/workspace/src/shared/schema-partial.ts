/**
 * `partialOf(schema, { keep })` — derive a "patch" schema for table updates.
 *
 * Builds a schema where the named `keep` fields stay required and every other
 * field becomes optional. Used for action input shapes like
 * `update({ id, ...patch })` where the row id is mandatory but every other
 * column is optional.
 *
 * ## Implementation
 *
 *   schema.pick(...keep).and(schema.omit(...keep).partial())
 *
 * arktype preserves morph brands across this composition: `pick` carries the
 * `.pipe(...)` morph through unchanged, and `.and()` merges property morphs
 * without erasing them. Verified by the Phase 4 spike at
 * `__spikes__/schema-partial.spike.test.ts` — branded ids like `EntryId`
 * survive the inferred input type, and runtime validation still rejects
 * malformed optional fields.
 *
 * @example
 * ```ts
 * import { type } from 'arktype';
 *
 * const Entry = type({ id: 'string', title: 'string', _v: '"1"' });
 * const Patch = partialOf(Entry, { keep: ['id'] });
 *
 * Patch({ id: 'x' });            // ok
 * Patch({ id: 'x', title: 'a' }); // ok
 * Patch({ title: 'no id' });     // errors (id required)
 * Patch({ id: 'x', _v: 99 });    // errors (literal mismatch)
 * ```
 */
import type { Type, type } from 'arktype';

/**
 * Compute the input shape produced by `partialOf`: required `id`-shaped fields
 * stay as-is, every other field becomes optional. Brands and morphs on the
 * required fields survive because arktype's `.pick` / `.and` preserve them.
 */
export type PartialOf<
	S extends type.Any,
	K extends keyof S['infer'] & string,
> = Type<
	Pick<S['infer'], K> & Partial<Omit<S['infer'], K>>,
	S['t'] extends { $: infer Scope } ? Scope : {}
>;

/**
 * Derive a partial-update schema from `schema` keeping `keep` fields required.
 *
 * Internal note: arktype's variadic `pick` / `omit` overloads bind to literal
 * string args; spreading a generic `readonly K[]` widens to `string` and trips
 * the strict overloads. One targeted internal cast on the runtime call works
 * around the variadic-signature mismatch; the brand-preserving inferred type
 * is reconstructed via the `PartialOf<S, K>` helper.
 */
export function partialOf<
	S extends type.Any,
	K extends keyof S['infer'] & string,
>(schema: S, opts: { keep: readonly K[] }): PartialOf<S, K> {
	const keep = opts.keep as readonly string[];
	// biome-ignore lint/suspicious/noExplicitAny: arktype's pick/omit overloads
	// require literal-string args; spreading a generic `K[]` widens to `string`.
	// The runtime call is correct; the cast only silences variadic-signature
	// mismatch, and PartialOf<S, K> reconstructs the brand-preserving type.
	const anySchema = schema as any;
	const required = anySchema.pick(...keep);
	const rest = anySchema.omit(...keep).partial();
	return required.and(rest) as PartialOf<S, K>;
}
