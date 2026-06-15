import type { Vocabulary } from '@epicenter/zhongwen';

export const ZHONGWEN_SYSTEM_PROMPT = `You are a bilingual Chinese-English language assistant. Your responses mix English and Mandarin Chinese naturally.

Guidelines:
- Use English for explanations, transitions, and meta-commentary
- Use Mandarin Chinese (simplified characters only, 简体字) for vocabulary, example sentences, and conversational phrases
- Never include pinyin in your responses: the client adds it automatically above each character
- Never use traditional characters (繁體字)
- When teaching vocabulary, present the Chinese naturally inline: "The word 学习 means to study"
- For example sentences, write them in Chinese then explain in English
- Adjust difficulty based on context clues from the user's questions
- Be conversational and encouraging

Example response style:
"The phrase 你好 is the most common greeting. For something more casual with friends, you can say 嘿 or 哈喽. In a formal setting, try 您好. The 您 shows extra respect."`;

/**
 * Build the per-conversation block that makes the dictionary steer the chat: the
 * words the learner is working on today, fed in so the assistant weaves them
 * into the conversation instead of the user drilling them on a flashcard. This
 * is the "magic": open a chat and today's words naturally turn up.
 *
 * `targetWords` comes from `reviewQueue`. Each word plays one of two roles for
 * this conversation, derived from its self-reported comfort, never a stored flag:
 *
 * - New words (mastery 0) get the RECOGNITION role: the assistant works them into
 *   its own lines with a brief inline gloss, so the learner simply meets them.
 * - Learning words (mastery 1) get the PRODUCTION role: the assistant sets up
 *   openings where the learner would naturally need to say the word themselves,
 *   without supplying it. This is where "use it, do not just see it" happens.
 *
 * A word migrates from recognition to production as the learner bumps its
 * comfort; the role is recomputed every kickoff. Known words (mastery 2) are
 * already filtered out by `reviewQueue`, so they never appear. Returns `null`
 * when nothing is in play, so the caller appends no block and the conversation
 * runs on the base prompt alone.
 */
export function buildVocabularySystemPrompt(
	targetWords: Vocabulary[],
): string | null {
	if (targetWords.length === 0) return null;

	const toRecognize = targetWords.filter((word) => word.mastery === 0);
	const toProduce = targetWords.filter((word) => word.mastery === 1);

	const lines = [
		'The learner is building a personal Chinese vocabulary. Weave the words below into the conversation by creating situations where they belong. Do not drill them, list them, or announce that you are using them.',
	];
	if (toRecognize.length > 0) {
		lines.push(
			`Introduce these new words yourself, naturally in your own lines, with a brief inline gloss the first time so the learner can start to recognize them: ${toRecognize.map((word) => word.text).join('、')}。`,
		);
	}
	if (toProduce.length > 0) {
		lines.push(
			`Set up situations where the learner would naturally need to produce these words themselves, then let them supply the word. Prompt and invite, but do not say the word for them: ${toProduce.map((word) => word.text).join('、')}。`,
		);
	}
	return lines.join('\n');
}
