import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, isErr, Ok, type Result, trySync } from 'wellcrafted/result';
import { complete, hasCompletionKey } from '$lib/operations/completion';
import { settings } from '$lib/state/settings.svelte';
import type { DictionaryEntry } from '$lib/workspace';

export const RunCleanupError = defineErrors({
	/**
	 * The auto-cleanup AI pass failed. Non-fatal: `fallback` carries the
	 * dictionary-corrected text so the pipeline can still deliver a usable
	 * transcript instead of losing the user's words to a tidy-pass error.
	 */
	AutoCleanupFailed: ({
		message,
		fallback,
	}: {
		message: string;
		fallback: string;
	}) => ({ message, fallback }),
});
export type RunCleanupError = InferErrors<typeof RunCleanupError>;

/**
 * The automatic correction layer, run once after every transcription. Two
 * mechanisms in fixed order: a deterministic `dictionary` pass (proper-noun and
 * term spellings) then, only when warranted, one AI tidy pass. The dictionary
 * runs first so a later AI pass never has to redo the spellings, and so
 * post-AI deterministic replacements are never needed (see ADR 0013 Refusals).
 *
 * The AI pass fires only when auto-cleanup is enabled AND a provider key is
 * actually configured: "on by default once a key exists" is a runtime gate, not
 * a settings flag, so a fresh keyless install silently delivers the
 * dictionary-corrected text with no surprise cost. Every input (`cleanup.*`,
 * `completion.*`, the key) is read at use per ADR 0012; nothing is cached.
 *
 * Pure execution: no workspace writes, no toasts. The pipeline owns delivery and
 * keeps the raw transcript on `recordings.transcript` underneath the cleaned
 * text. On AI failure the dictionary-corrected text rides along in the error so
 * delivery can still proceed.
 */
export async function runCleanup({
	input,
}: {
	input: string;
}): Promise<Result<string, RunCleanupError>> {
	const corrected = applyDictionary(input, settings.get('cleanup.dictionary'));

	const autoCleanup = settings.get('cleanup.autoCleanup');
	const shouldRunAi =
		autoCleanup.enabled && hasCompletionKey() && corrected.trim().length > 0;
	if (!shouldRunAi) return Ok(corrected);

	const result = await complete({
		systemPrompt: autoCleanup.instructions,
		userPrompt: corrected,
	});
	if (isErr(result)) {
		return RunCleanupError.AutoCleanupFailed({
			message: extractErrorMessage(result.error),
			fallback: corrected,
		});
	}
	return Ok(result.data);
}

/**
 * Apply the dictionary entries to `text` in order, each one a find/replace. The
 * default is a literal, case-sensitive match anywhere; `wholeWord` anchors it to
 * word boundaries and `regex` treats `heard` as a pattern (both advanced). An
 * empty `heard` is skipped (it would match nothing useful) and an invalid regex
 * is skipped rather than crashing the pipeline. `spell` replaces the match
 * (`""` deletes it); in literal mode its `$` is escaped so a stray `$1` is not
 * read as a backreference.
 */
function applyDictionary(text: string, entries: DictionaryEntry[]): string {
	let result = text;
	for (const entry of entries) {
		if (!entry.heard) continue;

		const base = entry.regex ? entry.heard : escapeRegExp(entry.heard);
		const pattern = entry.wholeWord ? `\\b${base}\\b` : base;
		const { data: regex } = trySync({
			try: () => new RegExp(pattern, 'g'),
			catch: (cause) => Err(extractErrorMessage(cause)),
		});
		if (!regex) continue;

		const replacement = entry.regex
			? entry.spell
			: entry.spell.replace(/\$/g, '$$$$');
		result = result.replace(regex, replacement);
	}
	return result;
}

/** Escape regex metacharacters so a literal dictionary entry matches verbatim. */
function escapeRegExp(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
