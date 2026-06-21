import staticAdapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: staticAdapter({
			fallback: 'index.html',
		}),
		alias: {
			'$platform/auth': './src/lib/platform/auth/auth.ts',
		},
	},
};

export default config;
