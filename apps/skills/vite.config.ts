import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type PluginOption } from 'vite';

export default defineConfig({
	// Each workspace has its own physical vite install (same version), so the
	// plugins' `Plugin` type is nominally distinct from this config's
	// `PluginOption`. Cast until the installs dedupe to one vite.
	plugins: [sveltekit(), tailwindcss()] as PluginOption[],
	resolve: {
		dedupe: ['yjs'],
	},
});
