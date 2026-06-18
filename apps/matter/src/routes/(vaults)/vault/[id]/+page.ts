import { error } from '@sveltejs/kit';
import { openVaults } from '$lib/open-vaults.svelte';
import type { PageLoad } from './$types';

/**
 * Resolve the route's opaque id back to a vault root. The persisted list is the only
 * place `id -> root` lives, so a not-open id (a stale deep-link or a closed tab) is a
 * clean 404 rendered by `+error.svelte`, not a crash. Returns the root only (serializable);
 * the LIVE vault is constructed in the component, since a watcher cannot leave `load`, and the
 * tab/title label is `basename(root)`, derived at render.
 */
export const load: PageLoad = ({ params }) => {
	const vault = openVaults.get(params.id);
	if (!vault) error(404, 'This vault is not open.');
	return { root: vault.root };
};
