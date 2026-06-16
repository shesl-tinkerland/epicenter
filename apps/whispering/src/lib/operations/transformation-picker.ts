import { report } from '$lib/report';

/**
 * TODO(wave-3): rebuild on Formats. The old picker captured the current
 * selection and opened a Tauri window listing transformations. The window and
 * its candidate UI were deleted with the `Transformation` model; Wave 3 rebuilds
 * the shared picker over the Format library (source = selection/transcript,
 * runner = `run({ input, format })`).
 */
export async function openTransformationPicker() {
	report.info({
		title: 'Formats are on the way',
		description: 'The format picker is coming in the next update.',
	});
}
