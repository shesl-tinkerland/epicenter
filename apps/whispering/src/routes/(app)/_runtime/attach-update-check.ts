import { tauri } from '#platform/tauri';
import { checkForUpdates } from './check-for-updates';

/**
 * Check for a newer Whispering release once at startup and surface it as a
 * report. Desktop only: the updater plugin has no browser counterpart. Fire and
 * forget, so there is nothing to tear down.
 */
export function attachUpdateCheck() {
	if (tauri) void checkForUpdates();
	return () => {};
}
