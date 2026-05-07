import { APPS } from '@epicenter/constants/apps';

/**
 * Pinned Chrome extension origin for the tab-manager.
 *
 * Stable across all installs because `apps/tab-manager/wxt.config.ts`
 * pins the manifest `key`. Allowlisting this exact origin replaces an
 * earlier `chrome-extension://*` wildcard that defeated CSRF protection.
 */
const TAB_MANAGER_CHROME_EXTENSION_ORIGIN =
	'chrome-extension://mkbnicfhpacdofmoocppnjjmdfmkkgda';

/**
 * Origins permitted by both CORS and Better Auth's CSRF check.
 *
 * Adding an app to `APPS` auto-extends this. Browser extensions are added
 * explicitly with their pinned origin: Chrome via the WXT `key`, Firefox
 * via `browser_specific_settings.gecko.id` plus AMO signing (required, no
 * exceptions; self-distributed XPIs get a random per-install UUID).
 *
 * Localhost dev URLs are trusted in production by design so developers can
 * iterate against the deployed API from `localhost:<port>`. Session cookies
 * are still per-origin scoped, so this is not a CSRF vector.
 *
 * The `http://api.epicenter.so` entry is for `wrangler dev`, which serves
 * the custom domain over plain HTTP. In production Cloudflare upgrades the
 * domain to HTTPS, so this Origin is never sent by a real browser there.
 */
export const TRUSTED_ORIGINS: string[] = [
	'tauri://localhost',
	TAB_MANAGER_CHROME_EXTENSION_ORIGIN,
	...Object.values(APPS).flatMap((app) => [
		...app.urls,
		`http://localhost:${app.port}`,
	]),
	`http://${new URL(APPS.API.urls[0]).host}`,
];
