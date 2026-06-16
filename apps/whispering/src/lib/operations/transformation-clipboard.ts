import { report } from '$lib/report';

/**
 * TODO(wave-3): repoint at the Format picker. The old behavior ran the user's
 * selected transformation (`transformation.selectedId`) over the clipboard, but
 * that selector is gone (the automatic path is now Cleanup, and Formats are
 * always picked). Wave 3 wires this command to run a chosen Format over the
 * clipboard via `run({ input, format })` from `$lib/operations/run-format`.
 */
export async function runTransformationOnClipboard() {
	report.info({
		title: 'Formats are on the way',
		description:
			'Running a saved format on the clipboard is coming in the next update.',
	});
}
