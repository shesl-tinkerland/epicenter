import { goto } from '$app/navigation';
import { WHISPERING_RECORDINGS_PATHNAME } from '$lib/constants/urls';
import { report } from '$lib/report';
import { services } from '$lib/services';
import { settings } from '$lib/state/settings.svelte';

type TranscriptionSource = 'recording' | 'upload';

const TRANSCRIPTION_SUCCESS_COPY = {
	recording: '📝 Recording transcribed',
	upload: '📁 File transcribed',
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
 * Delivers a Format's output to the user according to their text output
 * preferences. Returns the success Notice the caller passes to
 * `loading.resolve(...)`. `recordingId` is the run's link to a recording, or
 * null for ad-hoc runs (clipboard, selection): only a recording-anchored run
 * offers a "go to recordings" action, since an ad-hoc run has no history to open.
 */
export async function deliverFormatResult({
	text,
	recordingId,
}: {
	text: string;
	recordingId: string | null;
}) {
	return deliverResult({
		text,
		successCopy: '🔄 Format complete',
		settingsScope: 'format',
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
	settingsScope: 'transcription' | 'format';
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
