import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../src/config.ts';

/** A full AppConfig with test defaults; override per test. Bypasses env/file. */
export function makeConfig(over: Partial<AppConfig> = {}): AppConfig {
	return {
		dataDir: '/tmp/local-books-test',
		environment: 'sandbox',
		clientId: 'test-client',
		clientSecret: 'test-secret',
		redirectUri: 'http://localhost:8765/callback',
		scopes: ['com.intuit.quickbooks.accounting'],
		entities: ['Invoice'],
		apiBase: 'http://localhost:0',
		tokenUrl: 'http://localhost:0/oauth2/v1/tokens/bearer',
		authorizeUrl: 'https://appcenter.intuit.com/connect/oauth2',
		minorVersion: '70',
		cdcSafeWindowDays: 25,
		fullBackstopDays: 7,
		pageSize: 1000,
		keyringFile: null,
		realmOverride: null,
		callbackPort: null,
		...over,
	};
}

export const sampleGrant = {
	token_type: 'bearer',
	access_token: 'access-seed',
	refresh_token: 'refresh-seed',
	expires_in: 3600,
	x_refresh_token_expires_in: 8726400,
};

/** Make a throwaway temp directory and return it plus a cleanup fn. */
export function tempDir(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), 'local-books-'));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
