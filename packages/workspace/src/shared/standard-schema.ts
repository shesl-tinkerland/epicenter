import type { StandardJSONSchemaV1 } from '@standard-schema/spec';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, trySync } from 'wellcrafted/result';
import { createLogger } from 'wellcrafted/logger';

const log = createLogger('standard-schema');

/**
 * Errors produced by Standard-JSON-Schema conversion. The library recovers
 * from every one of these (falling back to a permissive schema), so these
 * ship to the logger, not through a Result.
 */
export const StandardSchemaError = defineErrors({
	UnitFallback: ({ unit }: { unit: unknown }) => ({
		message: `[arktype→JSON Schema] Unit type "${String(unit)}" (${typeof unit}) cannot be converted; using base schema as fallback`,
		unit,
	}),
	DefaultFallback: ({
		code,
		base,
	}: {
		code: string;
		base: Record<string, unknown>;
	}) => ({
		message: `[arktype→JSON Schema] Fallback triggered for code "${code}"; base schema: ${JSON.stringify(base)}`,
		code,
		base,
	}),
	ConversionFailed: ({ cause }: { cause: unknown }) => ({
		message: `[standardSchemaToJsonSchema] Conversion failed, using permissive fallback: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type StandardSchemaError = InferErrors<typeof StandardSchemaError>;

/**
 * Arktype-aware JSON Schema conversion for Standard Schemas.
 *
 * The shared `CombinedStandardSchema` type is re-exported from
 * `@epicenter/workspace` — import it from there when you need the constraint.
 *
 * @see https://standardschema.dev
 * @see https://github.com/standard-schema/standard-schema
 */

/**
 * Arktype fallback handlers for JSON Schema conversion.
 *
 * Arktype represents optional properties as `T | undefined` internally.
 * JSON Schema doesn't have an `undefined` type — it handles optionality via
 * the `required` array. The `unit` handler strips `undefined` from unions
 * so the conversion succeeds.
 *
 * Non-undefined fallbacks (morphs, predicates, proto types, etc.) are logged
 * via the workspace logger and preserve the partial schema so other fields
 * aren't lost.
 *
 * @see https://arktype.io/docs/json-schema - arktype's toJsonSchema docs
 */
const ARKTYPE_FALLBACK = {
	unit: (ctx: {
		code: 'unit';
		unit: unknown;
		base: Record<string, unknown>;
	}): Record<string, unknown> => {
		if (ctx.unit === undefined) return {};
		log.warn(StandardSchemaError.UnitFallback({ unit: ctx.unit }));
		return ctx.base;
	},
	default: (ctx: {
		code: string;
		base: Record<string, unknown>;
	}): Record<string, unknown> => {
		log.warn(
			StandardSchemaError.DefaultFallback({ code: ctx.code, base: ctx.base }),
		);
		return ctx.base;
	},
};

/**
 * Safely convert a Standard JSON Schema to a plain JSON Schema object.
 *
 * Uses the Standard JSON Schema interface (`~standard.jsonSchema.input`) which
 * is vendor-agnostic. For arktype, fallback handlers are passed via `libraryOptions`
 * to handle unconvertible types gracefully.
 *
 * ## Two-layer safety net
 *
 * 1. **Fallback handlers (arktype-specific)**: Intercept conversion issues per-node
 *    in the schema tree, allowing partial success. If a schema has 10 fields
 *    and only 1 has an unconvertible type, the other 9 are preserved.
 *
 * 2. **Outer catch**: Last-resort failsafe for truly catastrophic failures.
 *    Returns `{}` (permissive empty schema) if everything else fails.
 *
 * @see https://standardschema.dev/json-schema - Standard JSON Schema spec
 * @see https://arktype.io/docs/json-schema - arktype's toJsonSchema docs
 *
 * @param schema - Standard JSON Schema to convert
 * @returns JSON Schema object, or permissive `{}` on error
 */
export function standardSchemaToJsonSchema(
	schema: StandardJSONSchemaV1,
): Record<string, unknown> {
	const { data } = trySync({
		try: () =>
			schema['~standard'].jsonSchema.input({
				target: 'draft-2020-12',
				libraryOptions: {
					fallback: ARKTYPE_FALLBACK,
				},
			}),
		catch: (cause) => {
			log.warn(StandardSchemaError.ConversionFailed({ cause }));
			return Ok({});
		},
	});
	return data;
}
