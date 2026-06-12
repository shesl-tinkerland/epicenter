/**
 * The runtime `matter.json` parser/validator.
 *
 * `matter.json` at rest is `{ "fields": { [fieldName]: <a plain JSON Schema> } }`, where
 * each field value is a plain JSON Schema in the closed palette. This module turns that
 * raw JSON into a {@link MatterModel}: a flat list of {@link MatterField}s, each carrying
 * its kind (the widget / storage classifier) and its precompiled validator, computed
 * ONCE here when the model loads. "Field" is the source noun (the user defines a
 * folder's fields); SQLite is the one consumer that turns fields into table columns.
 *
 * The palette is the shared `@epicenter/field` vocabulary: the SAME kinds the workspace
 * authors through `field.*`, so `recognize` and `compile` round-trip matter's `matter.json`
 * over one wire-form. `json` is a kind (an arbitrary-JSON payload, marker-discriminated),
 * so matter renders it too. Matter's substrate policy keeps the emptiness axis outside
 * the value schema: `fields.*` is a pure JSON Schema for PRESENT values, while top-level
 * model policy decides whether a missing value is allowed. A nullable `anyOf`-with-null
 * shape is outside the palette and degrades to raw, and the per-kind widgets in
 * `components/fields/` map each `Kind` to its editor.
 *
 * The acceptance rule is the meta-schema in `@epicenter/field`: a field whose stored
 * shape is a legal palette member becomes a typed Field; a field OUTSIDE the palette (a
 * typo, an unmarked object, a nullable wrapper) is recorded in `unmodeled` and shown raw,
 * rather than erroring the whole model. Only WHOLE-FILE junk (bad JSON, no `fields`
 * object) rejects the model to the raw view.
 *
 * Optionality is a Matter policy, not a field-palette kind. By default every modeled
 * field is required; top-level `optional: ["name"]` names the exceptions. "Must have
 * content" is still a value constraint (e.g. `minLength`), not a requiredness flag.
 */

import { compile, type Field, recognize } from '@epicenter/field';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, trySync } from 'wellcrafted/result';

/** Why a stored `matter.json` could not be read into a usable model at all. */
export const MatterModelError = defineErrors({
	NotAnObject: () => ({ message: 'matter.json must be a JSON object' }),
	MissingFields: () => ({
		message: 'matter.json must have a "fields" object',
	}),
	InvalidOptional: () => ({
		message: 'matter.json optional must be an array of field names',
	}),
	InvalidJson: ({ cause }: { cause: unknown }) => ({
		message: `matter.json is not valid JSON: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type MatterModelError = InferErrors<typeof MatterModelError>;

/** A loaded Matter field: present-value schema plus missing-cell policy. */
export type MatterField = Field & {
	/** True when a missing cell should need attention; false when it is allowed. */
	required: boolean;
};

/** A folder's validated model: the typed fields plus any fields outside the palette. */
export type MatterModel = {
	/** The typed fields, in declared (insertion) order. */
	fields: MatterField[];
	/** Field names whose stored shape is outside the palette; shown raw, never typed. */
	unmodeled: string[];
	/** Optional entries that did not match a typed field, surfaced as model diagnostics. */
	unmatchedOptional: string[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate a parsed `matter.json` object into a {@link MatterModel}. Takes the
 * already-JSON-parsed value ({@link parseModel} reads the file text and handles the
 * syntax-error case). Per-field degrade: a field outside the palette is recorded in
 * `unmodeled`, never an error; only whole-file junk returns an `Err`.
 */
export function validateModel(
	raw: unknown,
): Result<MatterModel, MatterModelError> {
	if (!isPlainObject(raw)) return MatterModelError.NotAnObject();

	const fieldsRaw = raw.fields;
	if (!isPlainObject(fieldsRaw)) return MatterModelError.MissingFields();

	const optionalRaw = raw.optional;
	if (
		optionalRaw !== undefined &&
		(!Array.isArray(optionalRaw) ||
			optionalRaw.some((value) => typeof value !== 'string'))
	) {
		return MatterModelError.InvalidOptional();
	}
	const optional = optionalRaw ?? [];
	const optionalNames = new Set(optional);

	const fields: MatterField[] = [];
	const unmodeled: string[] = [];
	for (const [name, schema] of Object.entries(fieldsRaw)) {
		// The closed palette is the acceptance rule: `recognize` returns the kind paired
		// with its typed schema, or null for a shape outside it (a typo, an object, a
		// nullable `anyOf` wrapper). An unrecognized field is not a typed field: record it
		// so the UI can nudge, let its value surface as an unmodeled extra, and keep going.
		const recognized = recognize(schema);
		if (recognized === null) {
			unmodeled.push(name);
			continue;
		}
		// `recognized` carries the kind and its precisely-typed schema in one pass, so the
		// Field is built with no cast. `compile` runs once per field; its validator rides
		// on the Field for conformance to reuse.
		fields.push({
			name,
			...recognized,
			check: compile(recognized.schema),
			required: !optionalNames.has(name),
		});
	}

	const modeled = new Set(fields.map((field) => field.name));
	const unmatchedOptional = optional.filter((name) => !modeled.has(name));

	return Ok({ fields, unmodeled, unmatchedOptional });
}

/**
 * Parse the raw text of a `matter.json` file. Catches JSON syntax errors as an `Err`
 * (carrying the parser error as `cause`) rather than throwing, so a junk file degrades
 * to the raw view with a diagnostic.
 */
export function parseModel(
	text: string,
): Result<MatterModel, MatterModelError> {
	const { data: raw, error } = trySync({
		try: () => JSON.parse(text) as unknown,
		catch: (cause) => MatterModelError.InvalidJson({ cause }),
	});
	if (error) return Err(error);
	return validateModel(raw);
}
