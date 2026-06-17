import { describe, expect, test } from 'bun:test';
import { buildSystemPrompt } from './build-system-prompt';

describe('buildSystemPrompt', () => {
	test('returns instructions verbatim when the dictionary is empty', () => {
		const instructions = 'Fix grammar and punctuation. Keep my wording.';
		expect(buildSystemPrompt(instructions, [])).toBe(instructions);
	});

	test('appends a tagged term block when the dictionary is non-empty', () => {
		const result = buildSystemPrompt('Reply as an email.', [
			'Kubernetes',
			'Braden',
		]);

		// The directive is preserved up front.
		expect(result.startsWith('Reply as an email.')).toBe(true);
		// Each term is rendered as its own bullet inside one tagged block.
		expect(result).toContain('<known_terms>');
		expect(result).toContain('</known_terms>');
		expect(result).toContain('- Kubernetes');
		expect(result).toContain('- Braden');
	});
});
