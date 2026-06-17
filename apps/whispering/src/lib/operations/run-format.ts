import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { isErr, Ok, type Result } from 'wellcrafted/result';
import { complete } from '$lib/operations/completion';
import type { Format } from '$lib/workspace';

export const RunFormatError = defineErrors({
	InvalidInput: ({ message }: { message: string }) => ({ message }),
	Empty: ({ message }: { message: string }) => ({ message }),
	Failed: ({ message }: { message: string }) => ({ message }),
});
export type RunFormatError = InferErrors<typeof RunFormatError>;

/**
 * Run one Format over `input` and return its take: a single AI call whose
 * directive is `format.instructions` and whose content is `input`. Text in,
 * text out, nothing else: no pre/post replacements, no `{{input}}` template, no
 * per-Format model. Correction (Cleanup) has already run upstream, so `input`
 * is the corrected text and this never re-does cleanup.
 *
 * Provider and model come from the single global `completion.*` default (via
 * `complete`), not from the Format.
 *
 * Pure execution: no workspace writes, no persistence, no toasts. The picker
 * (Wave 3) is the caller; it owns delivery and any history bookkeeping.
 */
export async function run({
	input,
	format,
}: {
	input: string;
	format: Format;
}): Promise<Result<string, RunFormatError>> {
	if (!input.trim()) {
		return RunFormatError.InvalidInput({
			message: 'Empty input. Please enter some text to run a format on.',
		});
	}
	if (!format.instructions.trim()) {
		return RunFormatError.Empty({
			message: 'This format has no instructions. Add an instruction to run it.',
		});
	}

	const result = await complete({
		systemPrompt: format.instructions,
		userPrompt: input,
	});

	if (isErr(result)) {
		return RunFormatError.Failed({
			message: extractErrorMessage(result.error),
		});
	}
	return Ok(result.data);
}
