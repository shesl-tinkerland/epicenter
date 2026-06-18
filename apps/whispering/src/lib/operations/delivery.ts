import { goto } from '$app/navigation';
import { WHISPERING_RECORDINGS_PATHNAME } from '$lib/constants/urls';
import { report } from '$lib/report';
import { services } from '$lib/services';
import { settings } from '$lib/state/settings.svelte';

/**
 * The output scopes Whispering delivers into. Each has its own
 * clipboard/cursor/enter toggles under `output.<scope>.*`. Keeping the list in
 * one place lets delivery and the tap-hold capability derive from the same
 * source instead of hardcoding the scope names.
 */
const OUTPUT_SCOPES = ['transcription', 'recipe'] as const;
type OutputScope = (typeof OUTPUT_SCOPES)[number];

/**
 * True when any output scope is set to write at the cursor. Cursor delivery is a
 * synthetic Cmd/Ctrl+V, so this is exactly when delivery needs the macOS
 * Accessibility grant, which is the one fact the tap supervisor holds the tap to
 * track. Call inside a reactive scope to stay live as the toggles change.
 */
export function outputWritesToCursor(): boolean {
	return OUTPUT_SCOPES.some((scope) => settings.get(`output.${scope}.cursor`));
}

/**
 * Where a transcript originated: a live `recording` or an imported file
 * (`import`). Shapes the success copy and flows in from the pipeline's
 * `deliverySource`.
 */
export type TranscriptionSource = 'recording' | 'import';

const TRANSCRIPTION_SUCCESS_COPY = {
	recording: '📝 Recording transcribed',
	import: '📁 File transcribed',
} as const satisfies Record<TranscriptionSource, string>;

/**
 * Delivers transcript to the user according to their text output preferences
 * (copy to clipboard, write to cursor, simulate enter). Side-effect failures
 * surface as independent toasts. Returns the success Notice the caller passes
 * to `loading.resolve(...)`; ownership of the loading handle stays with the
 * caller.
 */
export async function deliverTranscriptionResult({
	text,
	source = 'recording',
}: {
	text: string;
	source?: TranscriptionSource;
}) {
	return deliverResult({
		text,
		successCopy: TRANSCRIPTION_SUCCESS_COPY[source],
		settingsScope: 'transcription',
		// A transcription always belongs to a recording, so its history is reachable.
		linkedRecording: true,
	});
}

/**
 * Delivers a Recipe's output to the user according to their text output
 * preferences. Returns the success Notice the caller passes to
 * `loading.resolve(...)`. `recordingId` is the run's link to a recording, or
 * null for ad-hoc runs (clipboard, selection): only a recording-anchored run
 * offers a "go to recordings" action, since an ad-hoc run has no history to open.
 */
export async function deliverRecipeResult({
	text,
	recordingId,
}: {
	text: string;
	recordingId: string | null;
}) {
	return deliverResult({
		text,
		successCopy: '🔄 Recipe complete',
		settingsScope: 'recipe',
		linkedRecording: recordingId !== null,
	});
}

async function deliverResult({
	text,
	successCopy,
	settingsScope,
	linkedRecording,
}: {
	text: string;
	successCopy: string;
	settingsScope: OutputScope;
	linkedRecording: boolean;
}) {
	const recordingsAction = linkedRecording
		? {
				label: 'Go to recordings',
				onClick: () => goto(WHISPERING_RECORDINGS_PATHNAME),
			}
		: undefined;

	const copyToClipboardAction = {
		label: 'Copy to clipboard',
		onClick: async () => {
			const { error } = await services.text.copyToClipboard(text);
			if (error) {
				report.error({
					title: "Couldn't copy to clipboard",
					cause: error,
				});
				return;
			}
			report.success({
				title: 'Copied to clipboard!',
				description: text,
			});
		},
	};

	let copied = false;
	let written = false;

	if (settings.get(`output.${settingsScope}.clipboard`)) {
		const { error: copyError } = await services.text.copyToClipboard(text);
		if (!copyError) {
			copied = true;
		} else {
			report.error({
				title: "Couldn't copy to clipboard",
				cause: copyError,
			});
		}
	}

	if (settings.get(`output.${settingsScope}.cursor`)) {
		const { error: writeError } = await services.text.writeToCursor(text);
		if (!writeError) {
			written = true;
			if (settings.get(`output.${settingsScope}.enter`)) {
				const { error: enterError } =
					await services.text.simulateEnterKeystroke();
				if (enterError) {
					report.info({
						title: 'Unable to simulate Enter keystroke',
						cause: enterError,
					});
				}
			}
		} else {
			report.info({
				title: 'Unable to write to cursor automatically',
				cause: writeError,
				action: copyToClipboardAction,
			});
		}
	}

	if (copied && written) {
		return {
			title: `${successCopy}, copied to clipboard, and written to cursor!`,
			description: text,
			action: recordingsAction,
		};
	}
	if (copied) {
		return {
			title: `${successCopy} and copied to clipboard!`,
			description: text,
			action: recordingsAction,
		};
	}
	if (written) {
		return {
			title: `${successCopy} and written to cursor!`,
			description: text,
			action: recordingsAction,
		};
	}
	return {
		title: `${successCopy}!`,
		description: text,
		action: copyToClipboardAction,
	};
}
