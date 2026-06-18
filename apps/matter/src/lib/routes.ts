/**
 * The app's URL grammar in one place. Every link, redirect, and `goto` builds its path here
 * instead of hand-writing `/vault/${id}`, so the route shape has a single owner: change it once
 * and the compiler finds every caller. Pure and stateless (the tab LIST is `open-vaults`', the
 * active vault is the URL's, the active table is the URL's too via `?table=`), so this is
 * functions, not a store. Callers pass these strings straight to `goto`, `<a href>`, or `redirect`.
 */

/** The query-param key the active table is addressed by. Read and write share it, so they agree. */
export const TABLE_PARAM = 'table';

export const routes = {
	/** The onboarding index, shown only when no vault is open. */
	home: () => '/',
	/** A vault tab, addressed by its opaque persisted id. */
	vault: (id: string) => `/vault/${id}`,
	/**
	 * Select a table within the active vault. A relative query (no id), so switching tables stays
	 * on the same vault route without rebuilding its id or remounting its watcher.
	 */
	table: (name: string) => `?${TABLE_PARAM}=${encodeURIComponent(name)}`,
};
