// @ts-check

import svelte from '@astrojs/svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	output: 'static', // Keep static for now, can change to 'server' if needed
	vite: {
		plugins: [tailwindcss()],
		// Vite 7 environments read resolve.noExternal; ssr.noExternal stays for
		// compatibility. Without both, prerendering pages that pull bits-ui in
		// through @epicenter/ui fails with ERR_UNKNOWN_FILE_EXTENSION (.svelte).
		resolve: {
			noExternal: ['bits-ui', 'svelte-toolbelt', 'runed'],
		},
		ssr: {
			noExternal: ['bits-ui', 'svelte-toolbelt', 'runed'],
		},
	},
	integrations: [svelte()],
});
