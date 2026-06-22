import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { APPS } from '@epicenter/constants/apps';
import { workspaceAppViteConfig } from '@epicenter/vite-config';
import {
	defaultClientConditions,
	defineConfig,
	mergeConfig,
	normalizePath,
} from 'vite';
import devtoolsJson from 'vite-plugin-devtools-json';
import { viteStaticCopy } from 'vite-plugin-static-copy';

const host = process.env.TAURI_DEV_HOST;
const isTauri = process.env.TAURI_ENV_PLATFORM !== undefined;

// VAD fetches these files from `/vad/*` at runtime (they are not bundled), so
// copy them out of the installed packages at build time to keep the served
// assets aligned with the lockfile. onnxruntime-web is a transitive dependency
// of @ricky0123/vad-web, not declared by this app, so it is unreachable from
// here under an isolated (pnpm-style) node_modules. Resolve it relative to
// vad-web's own entry instead, which works under both hoisted and isolated
// installs. Resolve each package's entry, not a package.json subpath, which
// onnxruntime-web blocks via `exports`.
const requireFromConfig = createRequire(import.meta.url);
const vadEntry = requireFromConfig.resolve('@ricky0123/vad-web');
const vadDist = dirname(vadEntry);
const requireFromVad = createRequire(vadEntry);
const ortDist = dirname(requireFromVad.resolve('onnxruntime-web'));
// vite-plugin-static-copy treats src as a glob, so Windows backslashes must
// become forward slashes before tinyglobby tries to match these files.
const vadAssetSources = [
	join(vadDist, 'vad.worklet.bundle.min.js'),
	join(vadDist, 'silero_vad_v5.onnx'),
	join(ortDist, 'ort-wasm-simd-threaded.mjs'),
	join(ortDist, 'ort-wasm-simd-threaded.wasm'),
].map(normalizePath);

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
		// .vite/deps/ort-wasm-simd-threaded.mjs). Keep that package and its wasm
		// subpath native, but still prebundle vad-web so Vite converts its
		// CommonJS entry to ESM for browser dev mode.
		optimizeDeps: {
			exclude: ['onnxruntime-web', 'onnxruntime-web/wasm'],
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
