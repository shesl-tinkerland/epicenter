import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type PluginOption } from 'vite';

// Matter is desktop-only (Tauri). There is no browser build to branch on, so the
// app imports `@tauri-apps/*` directly; develop with `bun run tauri dev`.
export default defineConfig({
	// Each workspace has its own physical vite install (same version), so the
	// plugins' `Plugin` type is nominally distinct from this config's
	// `PluginOption`. Cast until the installs dedupe to one vite.
	plugins: [sveltekit(), tailwindcss()] as PluginOption[],
	clearScreen: false,
	server: {
		// Tauri's devUrl points here; the port must be fixed.
		port: 5180,
		strictPort: true,
		watch: { ignored: ['**/src-tauri/**'] },
	},
});
