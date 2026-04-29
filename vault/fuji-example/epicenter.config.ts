/**
 * Fuji example vault: end-to-end exercise for the daemon-side factory.
 *
 * Imports `openFuji` from `@epicenter/fuji/daemon` (single-writer persistence
 * + cloud sync + sqlite/markdown materializers) and exposes `fuji` as a
 * `LoadedWorkspace` so `epicenter serve -C vault/fuji-example` picks it up.
 *
 * Auth is loaded from the CLI session store at `~/.epicenter/auth/sessions.json`
 * (run `epicenter auth login` first). Mirrors the pattern used by
 * `playground/opensidian-e2e/epicenter.config.ts`.
 *
 * Usage:
 *   # Start the daemon (long-lived materializer worker)
 *   epicenter serve -C vault/fuji-example
 *
 *   # In another terminal, run the script factory against the same vault
 *   bun run vault/fuji-example/scripts/list-entries.ts
 */

import { openFuji } from '@epicenter/fuji/daemon';
import { attachSessionUnlock, createSessionStore } from '@epicenter/cli';

const SERVER_URL = process.env.EPICENTER_SERVER ?? 'https://api.epicenter.so';

const sessions = createSessionStore();

export const fuji = openFuji({
	absDir: import.meta.dir,
	authToken: async () => (await sessions.load(SERVER_URL))?.accessToken ?? null,
});

// Activate encryption keys once the daemon's persistence has hydrated. The
// daemon factory does not unlock encryption itself (it just constructs the
// raw bundle), so we layer `attachSessionUnlock` on top here. Scripts read
// the persistence file directly and do not need to unlock for plaintext
// reads in this example, but this matches the production-ready shape.
attachSessionUnlock(fuji.encryption, {
	sessions,
	serverUrl: SERVER_URL,
	waitFor: fuji.persistence.whenLoaded,
});
