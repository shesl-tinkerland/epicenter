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
 * Whether a Polish AI pass will actually run for `input`: Polish enabled AND a
 * provider key configured AND non-empty input. "On by default once a key
 * exists" is a runtime gate, not a settings flag, so a keyless install (or a
 * user in speed mode) skips the call. The single source for this decision so
 * the pipeline can show the "Polishing..." HUD only when an AI call is really
 * about to happen (no flicker in speed mode); `runPolish` reads it too. Read at
 * use per ADR 0012; nothing is cached.
 */
export function polishWillRun(input: string): boolean {
	return (
		settings.get('polish.enabled') &&
		hasCompletionKey() &&
		input.trim().length > 0
	);
}

/**
 * Polish: the always-on, meaning-preserving AI base, run once after every
 * transcription. One optional completion whose system prompt is
 * `polish.instructions` plus a Dictionary block (via `buildSystemPrompt`) and
 * whose content is the raw transcript. Skips the call (returns the raw input)
 * whenever {@link polishWillRun} is false.
 *
 * `signal` lets the caller cancel the in-flight pass (the HUD's "ship raw"):
 * when it aborts, the raw input is returned as a clean success, not an error,
 * because shipping the raw transcript was the user's explicit intent.
 *
 * Pure execution: no workspace writes, no toasts. The pipeline owns delivery and
 * keeps the raw transcript on `recordings.transcript` underneath the polished
 * text. On a genuine AI failure the raw input rides along in the error so
 * delivery can still proceed.
 */
export async function runPolish({
	input,
	signal,
}: {
	input: string;
	signal?: AbortSignal;
}): Promise<Result<string, RunPolishError>> {
	if (!polishWillRun(input)) return Ok(input);

	const result = await complete({
		systemPrompt: buildSystemPrompt(
			settings.get('polish.instructions'),
			settings.get('dictionary'),
		),
		userPrompt: input,
		signal,
	});
	if (isErr(result)) {
		// A user-requested abort is not a failure: ship the raw transcript cleanly.
		if (signal?.aborted) return Ok(input);
		return RunPolishError.PolishFailed({
			message: extractErrorMessage(result.error),
			fallback: input,
		});
	}
	return Ok(result.data);
}
