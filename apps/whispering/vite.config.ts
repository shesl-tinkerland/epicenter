import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { APPS } from '@epicenter/constants/apps';
import { workspaceAppViteConfig } from '@epicenter/vite-config';
import { defaultClientConditions, defineConfig, mergeConfig } from 'vite';
import devtoolsJson from 'vite-plugin-devtools-json';
import { viteStaticCopy } from 'vite-plugin-static-copy';

const host = process.env.TAURI_DEV_HOST;
const isTauri = process.env.TAURI_ENV_PLATFORM !== undefined;

// VAD runtime assets (Silero model, audio worklet, ONNX Runtime WASM glue) are
// fetched at runtime from `/vad/*`, not imported through the bundler. Rather
// than commit frozen copies, derive them from the installed packages on every
// build so the served files always match the lockfile-pinned versions. Both
// packages ship their entry inside `dist/` alongside these assets, so resolving
// the entry and taking its directory yields the asset dir; resolving the entry
// (rather than a `package.json` subpath, which onnxruntime-web blocks via
// `exports`) is also hoist-agnostic (root vs app node_modules).
const require = createRequire(import.meta.url);
const distOf = (pkg: string) => dirname(require.resolve(pkg));
const vadDist = distOf('@ricky0123/vad-web');
const ortDist = distOf('onnxruntime-web');
const vadAssetSources = [
	join(vadDist, 'vad.worklet.bundle.min.js'),
	join(vadDist, 'silero_vad_v5.onnx'),
	join(ortDist, 'ort-wasm-simd-threaded.mjs'),
	join(ortDist, 'ort-wasm-simd-threaded.wasm'),
];

export default defineConfig(
	mergeConfig(workspaceAppViteConfig(APPS.WHISPERING), {
		plugins: [
			devtoolsJson(),
			viteStaticCopy({
				// `stripBase` drops the source's directory segments so each file
				// lands directly at /vad/<name> (the plugin otherwise mirrors the
				// full absolute source path under dest).
				targets: vadAssetSources.map((src) => ({
					src,
					dest: 'vad',
					rename: { stripBase: true },
				})),
			}),
		],
		// onnxruntime-web (pulled in by @ricky0123/vad-web) ships a WASM glue
		// .mjs that Vite's dep optimizer can't pre-bundle (it 404s on
		// .vite/deps/ort-wasm-simd-threaded.mjs). Exclude both so they load
		// natively; their runtime assets are served from /vad/ (see above).
		optimizeDeps: {
			exclude: ['onnxruntime-web', '@ricky0123/vad-web'],
		},
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
