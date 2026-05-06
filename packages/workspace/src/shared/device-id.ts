/**
 * Per-installation id helpers.
 *
 * The peer action layer addresses peers by a single string. For
 * first-match-wins resolution to be safe, that string must be unique per
 * installation. Browser tabs in the same app share localStorage and therefore
 * share an installation id. Separate machines get distinct installation ids.
 */

import { generateGuid } from './id.js';

export type SimpleStorage = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
};

export type AsyncStorage = {
	getItem(key: string): Promise<string | null>;
	setItem(key: string, value: string): Promise<void>;
};

const KEY = 'epicenter:installationId';

export function getOrCreateInstallationId<T extends string = string>(
	storage: SimpleStorage,
): T {
	const existing = storage.getItem(KEY);
	if (existing) return existing as T;
	const fresh = generateGuid();
	storage.setItem(KEY, fresh);
	return fresh as unknown as T;
}

export async function getOrCreateInstallationIdAsync<
	T extends string = string,
>(storage: AsyncStorage): Promise<T> {
	const existing = await storage.getItem(KEY);
	if (existing) return existing as T;
	const fresh = generateGuid();
	await storage.setItem(KEY, fresh);
	return fresh as unknown as T;
}
