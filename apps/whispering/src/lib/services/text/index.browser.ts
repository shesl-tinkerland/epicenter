import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { TextService, WriteTextOutcome } from './types';
import { TextError } from './types';

export type { TextError, TextService } from './types';

export const TextServiceLive = {
	readFromClipboard: () =>
		tryAsync({
			try: async () => {
				const text = await navigator.clipboard.readText();
				return text || null;
			},
			catch: (error) => TextError.ClipboardRead({ cause: error }),
		}),

	copyToClipboard: async (text) => {
		const { error: copyError } = await tryAsync({
			try: () => navigator.clipboard.writeText(text),
			catch: (error) => TextError.ClipboardWrite({ cause: error }),
		});

		if (copyError) {
			// Extension fallback code commented out for now
			// Could be re-enabled if extension support is needed
			return Ok(undefined);
		}
		return Ok(undefined);
	},

	writeToCursor: async (text): Promise<Result<WriteTextOutcome, TextError>> => {
		// Browsers cannot programmatically paste for security reasons, so the best we
		// can do is leave the text on the clipboard for the user to paste manually.
		// That is the `leftOnClipboard` reach, not a failure.
		const { error } = await tryAsync({
			try: () => navigator.clipboard.writeText(text),
			catch: (error) => TextError.WriteToCursor({ cause: error }),
		});
		if (error) return Err(error);
		return Ok('leftOnClipboard');
	},

	simulateEnterKeystroke: async () =>
		TextError.NotSupported({
			operation: 'Simulating keystrokes',
		}),

	simulateCopyKeystroke: async () =>
		TextError.NotSupported({
			operation: 'Simulating keystrokes',
		}),
} satisfies TextService;
