import { InstantString } from '@epicenter/field';
import { goto } from '$app/navigation';
import { deliverTransformationResult } from '$lib/operations/delivery';
import { sound } from '$lib/operations/sound';
import {
	executeTransformation,
	persistCompletedRun,
} from '$lib/operations/transform';
import { report } from '$lib/report';
import { services } from '$lib/services';
import { settings } from '$lib/state/settings.svelte';
import { transformations } from '$lib/state/transformations.svelte';

/**
 * Run the user's default transformation on the clipboard, no UI. The quick-run
 * sibling of the transformation picker: copy text, hit the shortcut, get the
 * result delivered. An ad-hoc run, so it commits one completed row only on
 * success (see `persistCompletedRun`).
 */
export async function runTransformationOnClipboard() {
	const transformationId = settings.get('transformation.selectedId');

	if (!transformationId) {
		report.info({
			title: 'No transformation selected',
			description: 'Please select a transformation in settings first.',
			action: {
				label: 'Select a transformation',
				onClick: () => goto('/transformations'),
			},
		});
		return;
	}

	const transformation = transformations.get(transformationId);

	if (!transformation) {
		settings.set('transformation.selectedId', null);
		report.info({
			title: 'Transformation not found',
			description:
				'The selected transformation no longer exists. Please select a different one.',
			action: {
				label: 'Select a transformation',
				onClick: () => goto('/transformations'),
			},
		});
		return;
	}

	const { data: clipboardText, error: readClipboardError } =
		await services.text.readFromClipboard();

	if (readClipboardError) {
		report.error({
			title: 'Failed to read clipboard',
			cause: readClipboardError,
		});
		return;
	}

	if (!clipboardText?.trim()) {
		report.info({
			title: 'Empty clipboard',
			description: 'Please copy some text before running a transformation.',
		});
		return;
	}

	const loading = report.loading({
		title: '🔄 Running transformation...',
		description: 'Transforming your clipboard text...',
	});

	// Ad-hoc run: execute purely, then commit one completed row only on success.
	// A failed quick-run never committed, so it leaves no record.
	const startedAt = InstantString.now();
	const { data: transformedText, error: transformError } =
		await executeTransformation({ input: clipboardText, transformation });

	if (transformError) {
		loading.reject({ cause: transformError });
		return;
	}

	persistCompletedRun({
		transformationId: transformation.id,
		input: clipboardText,
		output: transformedText,
		startedAt,
	});

	sound.playSoundIfEnabled('transformationComplete');

	const { notice: successNotice } = await deliverTransformationResult({
		text: transformedText,
		recordingId: null,
	});
	loading.resolve(successNotice);
}
