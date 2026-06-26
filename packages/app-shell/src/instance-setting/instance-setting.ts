/**
 * The per-app persisted choice of which Epicenter star this install talks to
 * (ADR-0069: privacy is which deployment runs the program). Default is the
 * hosted cloud with no token (normal OAuth); a self-hoster overrides the base
 * URL and pastes a token their box minted.
 *
 * Every app (fuji, opensidian, vocab, ...) had a byte-identical copy of this
 * logic that varied only in the storage key and the hosted default origin, so it
 * lives here once. An app binds it to its own key:
 *
 *   export const instanceSetting = createInstanceSetting({
 *     storageKey: 'fuji.instance',
 *     defaultBaseURL: APP_URLS.API,
 *   });
 *
 * Plain localStorage, not a reactive store: `#platform/auth` reads it once,
 * synchronously, while constructing the auth client at module load. Changing the
 * instance writes here and reloads, so construction re-reads the new value. The
 * settings UI keeps its own form `$state` and never needs this to be reactive.
 */

import { type Instance, normalizeInstanceUrl } from '@epicenter/auth';

/** The bound instance setting an app exports and its modal consumes. */
export type InstanceSetting = {
	/** The hosted default ({@link createInstanceSetting}'s `defaultBaseURL`, no token). */
	defaultInstance: Instance;
	/** True when no self-host override is in effect. */
	isDefaultInstance(instance: Instance): boolean;
	/** Read the persisted instance, falling back to the hosted default. */
	readInstance(): Instance;
	/** Persist an instance. Callers reload so auth construction re-reads it. */
	writeInstance(instance: Instance): void;
	/** Forget the override and revert to the hosted default. */
	clearInstance(): void;
};

/**
 * Build an app's instance setting, parameterized only by what actually varies
 * across apps: the localStorage `storageKey` and the hosted `defaultBaseURL`
 * (the app's build-time API origin). The returned closures hold no `this`, so an
 * app may destructure them freely.
 */
export function createInstanceSetting({
	storageKey,
	defaultBaseURL,
}: {
	storageKey: string;
	defaultBaseURL: string;
}): InstanceSetting {
	const defaultInstance: Instance = { baseURL: defaultBaseURL };

	return {
		defaultInstance,
		isDefaultInstance(instance) {
			return instance.baseURL === defaultInstance.baseURL && !instance.token;
		},
		/**
		 * A missing, non-JSON, or unparseable record reads as the default rather
		 * than throwing, so a bad write can never wedge the app at boot. The base
		 * URL is re-normalized on read so a hand-edited record cannot smuggle in a
		 * malformed origin.
		 */
		readInstance() {
			if (typeof localStorage === 'undefined') return defaultInstance;
			const raw = localStorage.getItem(storageKey);
			if (raw === null) return defaultInstance;
			try {
				const parsed = JSON.parse(raw) as Partial<Instance>;
				const { data: baseURL } = normalizeInstanceUrl(
					String(parsed.baseURL ?? ''),
				);
				if (!baseURL) return defaultInstance;
				const token =
					typeof parsed.token === 'string' && parsed.token.trim() !== ''
						? parsed.token
						: undefined;
				return { baseURL, token };
			} catch {
				return defaultInstance;
			}
		},
		writeInstance(instance) {
			localStorage.setItem(storageKey, JSON.stringify(instance));
		},
		clearInstance() {
			localStorage.removeItem(storageKey);
		},
	};
}
