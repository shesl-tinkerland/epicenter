import { APPS } from '@epicenter/constants/apps';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type PluginOption } from 'vite';

// Dashboard is same-origin with API: in prod, served as static assets from
// `api.epicenter.so/dashboard`; in dev, the proxy below routes /api and /auth
// to the local Worker so the browser only sees same-origin requests.
const DASHBOARD_DEV_PORT = 5178;

export default defineConfig({
	// Each workspace has its own physical vite install (same version), so the
	// plugins' `Plugin` type is nominally distinct from this config's
	// `PluginOption`. Cast until the installs dedupe to one vite.
	plugins: [sveltekit(), tailwindcss()] as PluginOption[],
	server: {
		port: DASHBOARD_DEV_PORT,
		strictPort: true,
		proxy: {
			// Forward API requests to the local Hono dev server
			'/api': {
				target: `http://localhost:${APPS.API.port}`,
				changeOrigin: true,
			},
			// Forward auth requests for session cookies
			'/auth': {
				target: `http://localhost:${APPS.API.port}`,
				changeOrigin: true,
			},
		},
	},
});
