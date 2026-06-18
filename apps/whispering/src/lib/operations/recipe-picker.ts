import { report } from '$lib/report';

/**
 * TODO(wave-4): rebuild on Recipes. The old picker captured the current
 * selection and opened a Tauri window listing saved actions; that window and its
 * candidate UI were deleted in the ADR 0021 rewrite. Wave 4 rebuilds the shared
 * picker over the Recipe library (source = selection/transcript, runner =
 * `runRecipe({ input, recipe })`).
 */
export async function openRecipePicker() {
	report.info({
		title: 'Recipes are on the way',
		description: 'The recipe picker is coming in the next update.',
	});
}
