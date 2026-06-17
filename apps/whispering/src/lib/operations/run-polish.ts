import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { isErr, Ok, type Result } from 'wellcrafted/result';
import { buildSystemPrompt } from '$lib/operations/build-system-prompt';
import { complete, hasCompletionKey } from '$lib/operations/completion';
import { settings } from '$lib/state/settings.svelte';

export const RunPolishError = defineErrors({
	/**
	 * The Polish AI pass failed. Non-fatal: `fallback` carries the raw input so
	 * the pipeline can still deliver a usable transcript instead of losing the
	 * user's words to a polish error.
	 */
	PolishFailed: ({
		message,
		fallback,
	}: {
		message: string;
		fallback: string;
	}) => ({ message, fallback }),
});
export type RunPolishError = InferErrors<typeof RunPolishError>;

/**
 * Polish: the always-on, meaning-preserving AI base, run once after every
 * transcription. One optional completion whose system prompt is
 * `polish.instructions` plus a Dictionary block (via `buildSystemPrompt`) and
 * whose content is the raw transcript.
 *
 * The pass fires only when Polish is enabled AND a provider key is actually
 * configured AND the input is non-empty: "on by default once a key exists" is a
 * runtime gate, not a settings flag, so a fresh keyless install (or a user who
 * turned Polish off for speed mode) silently returns the raw transcript with no
 * surprise cost. Every input (`polish.*`, `dictionary`, `completion.*`, the key)
 * is read at use per ADR 0012; nothing is cached.
 *
 * Pure execution: no workspace writes, no toasts. The pipeline owns delivery and
 * keeps the raw transcript on `recordings.transcript` underneath the polished
 * text. On AI failure the raw input rides along in the error so delivery can
 * still proceed.
 */
export async function runPolish({
	input,
}: {
	input: string;
}): Promise<Result<string, RunPolishError>> {
	const shouldRun =
		settings.get('polish.enabled') &&
		hasCompletionKey() &&
		input.trim().length > 0;
	if (!shouldRun) return Ok(input);

	const result = await complete({
		systemPrompt: buildSystemPrompt(
			settings.get('polish.instructions'),
			settings.get('dictionary'),
		),
		userPrompt: input,
	});
	if (isErr(result)) {
		return RunPolishError.PolishFailed({
			message: extractErrorMessage(result.error),
			fallback: input,
		});
	}
	return Ok(result.data);
}
