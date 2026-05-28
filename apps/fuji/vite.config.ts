import { APPS } from '@epicenter/constants/apps';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const host = process.env.TAURI_DEV_HOST;
const isTauri = process.env.TAURI_ENV_PLATFORM !== undefined;

export default defineConfig({
	plugins: [sveltekit(), tailwindcss()],
	resolve: {
		dedupe: ['yjs'],
		extensions: isTauri
			? [
					'.tauri.ts',
					'.tauri.js',
					'.browser.ts',
					'.browser.js',
					'.ts',
					'.js',
					'.json',
				]
			: ['.browser.ts', '.browser.js', '.ts', '.js', '.json'],
	},
	clearScreen: false,
	server: {
		port: APPS.FUJI.port,
		strictPort: true,
		host: host || false,
		hmr: host
			? {
					protocol: 'ws',
					host,
					port: 5175,
				}
			: undefined,
		watch: {
			ignored: ['**/src-tauri/**'],
		},
	},
});
