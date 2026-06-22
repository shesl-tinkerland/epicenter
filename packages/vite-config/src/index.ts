import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { searchForWorkspaceRoot, type UserConfig } from 'vite';

/**
 * Base Vite config for SvelteKit workspace apps whose package contract and
 * browser composition live at the app root, outside `src/`.
 *
 * The `yjs` dedupe is load-bearing for CRDT identity.
 *
 * The `fs.allow` entry is load-bearing too, but not because of Vite's own
 * default. @sveltejs/kit's plugin sets fs.allow to the app `src/`, the app and
 * workspace-root `node_modules`, and its own output, and nothing else. That
 * omits the monorepo root, so the app-root composition files (the package
 * contract and browser entry that live outside `src/`) and sibling-package
 * source are unreadable in dev. Adding the workspace root restores both; Vite
 * concatenates it with SvelteKit's entries rather than replacing them.
 */
export function workspaceAppViteConfig(app: { port: number }): UserConfig {
	return {
		// No cast: the isolated install resolves a single `vite` peer-variant that
		// every package (this one, the app, @sveltejs/kit, @tailwindcss/vite)
		// symlinks to, so the plugins' `Plugin` type matches this `UserConfig`. If
		// CI ever reports `Two different types with this name exist, but they are
		// unrelated` on this line again, bun re-split `vite` into peer-variants
		// (`vite@7.3.5+<hashA>` vs `+<hashB>`); restore `as UserConfig['plugins']`
		// here, the one place every workspace app's plugins come from.
		plugins: [sveltekit(), tailwindcss()],
		resolve: {
			dedupe: ['yjs'],
		},
		server: {
			port: app.port,
			strictPort: true,
			fs: { allow: [searchForWorkspaceRoot(process.cwd())] },
		},
	};
}
