import { report } from '$lib/report';

/**
 * TODO(wave-4): repoint at the Recipe picker. The old behavior ran the user's
 * one selected saved action over the clipboard, but that selector is gone (the
 * automatic path is now Polish, and Recipes are always picked). Wave 4 wires
 * this command to run a chosen Recipe over the clipboard via
 * `runRecipe({ input, recipe })` from `$lib/operations/run-recipe`.
 */
export async function runRecipeOnClipboard() {
	report.info({
		title: 'Recipes are on the way',
		description:
			'Running a saved recipe on the clipboard is coming in the next update.',
	});
}
