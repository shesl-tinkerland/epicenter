import { APPS } from '@epicenter/constants/apps';

/**
 * Pinned Chrome extension origin for the tab-manager.
 *
 * Stable across all installs because `apps/tab-manager/wxt.config.ts` pins
 * the manifest `key`. Allowlisting this exact origin replaces an earlier
 * `chrome-extension://*` wildcard that let any user-installed extension
 * read API responses with credentials.
 */
const TAB_MANAGER_CHROME_EXTENSION_ORIGIN =
	'chrome-extension://mkbnicfhpacdofmoocppnjjmdfmkkgda';

/**
 * Origins permitted by Hono CORS and Better Auth (CSRF + callbackURL).
 *
 * One-sentence test: an origin is trusted iff a browser running our
 * deployed code at that origin is allowed to act as a signed-in user.
 *
 * What that sentence rejects, and why:
 *
 * - **localhost ports**: we do not deploy code on user machines. Dev
 *   frontends already target the local API by default (Vite's MODE-driven
 *   `APP_URLS` and the dashboard's same-origin proxy in `apps/dashboard/
 *   vite.config.ts`), so prod never legitimately sees `Origin: http://
 *   localhost:*`. Trusting localhost in prod also lets a phishing link
 *   like `?callbackURL=http://localhost:5173/anything` pass Better Auth's
 *   redirect validation, which is dangerous for developers running Vite.
 * - **http variants of production hosts**: we deploy over HTTPS. The
 *   previous `http://api.epicenter.so` entry was paying off a
 *   wrangler-dev custom-domain quirk that no real browser sees in
 *   production.
 * - **chrome-extension wildcards**: pinning the ID prevents any
 *   user-installed extension from acting as a signed-in user.
 */
// Frozen at runtime to prevent the long-lived Cloudflare isolate from
// accumulating mutations across requests. Typed as `string[]` (not
// `readonly string[]`) because Better Auth's `trustedOrigins` is mutable,
// and the readonly type leaks into its inferred Auth, breaking the OAuth
// metadata helpers in `app.ts`.
export const TRUSTED_ORIGINS: string[] = Object.freeze([
	'tauri://localhost',
	TAB_MANAGER_CHROME_EXTENSION_ORIGIN,
	...Object.values(APPS).flatMap((app) => app.urls),
]) as string[];
