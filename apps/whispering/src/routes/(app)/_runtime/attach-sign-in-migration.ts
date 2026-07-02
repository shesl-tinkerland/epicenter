import { signInMigration } from '$lib/migration/sign-in-migration';

/**
 * Signed-in only: prompt to migrate this device's local recordings into the
 * account (no-op when signed out or when there is no local data). Fire and
 * forget at startup; `signInMigration.check()` owns its own once-per-boot
 * guard, so there is nothing to tear down.
 */
export function attachSignInMigration() {
	void signInMigration.check();
	return () => {};
}
