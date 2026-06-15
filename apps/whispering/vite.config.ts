import { APPS } from '@epicenter/constants/apps';
import { workspaceAppViteConfig } from '@epicenter/vite-config';
import { defaultClientConditions, defineConfig, mergeConfig } from 'vite';
import devtoolsJson from 'vite-plugin-devtools-json';

const host = process.env.TAURI_DEV_HOST;
const isTauri = process.env.TAURI_ENV_PLATFORM !== undefined;

export default defineConfig(
	mergeConfig(workspaceAppViteConfig(APPS.WHISPERING), {
		plugins: [devtoolsJson()],
		resolve: {
			// Build-time platform DI. Each `#platform/*` subpath (package.json
			// "imports") has a browser impl and a Tauri impl; the Tauri build
			// activates the `tauri` condition, the web build uses `default`
			// (browser). A Tauri-only file imported by shared code is unresolvable
			// under the web condition, so it fails at vite build time, not at user
			// runtime. The `...defaultClientConditions` spread is load-bearing:
			// custom conditions REPLACE Vite's defaults.
			...(isTauri && { conditions: ['tauri', ...defaultClientConditions] }),
		},
		// Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
		//
		// 1. prevent vite from obscuring rust errors
		clearScreen: false,
		server: {
			host: host || false,
			hmr: host
				? {
						protocol: 'ws',
						host,
						port: 1421,
					}
				: undefined,
			watch: {
				// 2. tell vite to ignore watching `src-tauri`
				ignored: ['**/src-tauri/**'],
			},
		},
	}),
);
