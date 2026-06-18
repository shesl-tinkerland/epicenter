/**
 * Compose the system prompt shared by Polish and every Recipe: the caller's
 * `instructions` plus a tagged Dictionary block when the dictionary is non-empty.
 *
 * Pure by construction: it reads no settings and touches no I/O. The runners
 * (`runPolish`, `runRecipe`) read `dictionary` at use (ADR 0012) and pass it in,
 * so the term block rides on top of whatever directive the caller supplies. When
 * the dictionary is empty this returns `instructions` verbatim, so a user with no
 * known terms pays nothing for the feature.
 *
 * The block tells the model the terms are proper nouns and domain terms to keep
 * spelled as written and to map obvious mishearings onto: this is VoiceInk's
 * `<CUSTOM_VOCABULARY>` approach, letting the AI be the matcher with world
 * knowledge no edit-distance algorithm has. See ADR 0021.
 */
export function buildSystemPrompt(
	instructions: string,
	dictionary: string[],
): string {
	if (dictionary.length === 0) return instructions;
	const terms = dictionary.map((term) => `- ${term}`).join('\n');
	return `${instructions}

<known_terms>
The following are proper nouns and domain terms the user uses. Keep these exact spellings, and map obvious mishearings onto them:
${terms}
</known_terms>`;
}
