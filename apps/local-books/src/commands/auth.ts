import type { ParsedArgs } from '../cli.ts';
import { recordCompany } from '../companies.ts';
import { loadConfig } from '../config.ts';
import { createKeyring } from '../keyring.ts';
import { type OAuthDeps, runAuthorizationFlow } from '../oauth.ts';
import { storeToken } from '../token-manager.ts';
import { formatRelative } from './context.ts';

/**
 * One-time interactive OAuth2: open the browser, capture the localhost callback,
 * exchange the code, and store the token set in the keyring keyed by realmId.
 */
export async function runAuth(args: ParsedArgs): Promise<number> {
	const config = loadConfig({
		dataDir: args.dataDir,
		environment: args.environment,
		realm: args.realm,
	});

	if (!config.clientId || !config.clientSecret) {
		console.error(
			'Missing QuickBooks credentials. Set QB_CLIENT_ID and QB_CLIENT_SECRET\n' +
				'(or run via `infisical run --path=/apps/local-books`) from your Intuit\n' +
				'app (https://developer.intuit.com → your app → Keys & credentials).',
		);
		return 1;
	}

	const keyring = createKeyring(config);
	const deps: OAuthDeps = {
		now: () => Date.now(),
		log: (m) => console.error(m),
	};

	console.error(`Authenticating against QuickBooks (${config.environment})...`);
	const { data: token, error } = await runAuthorizationFlow(config, deps);
	if (error) {
		console.error(`auth failed: ${error.message}`);
		return 1;
	}

	await storeToken(keyring, token);
	recordCompany(config.dataDir, token.realmId);

	const now = Date.now();
	console.log(`Connected company ${token.realmId} (${config.environment}).`);
	console.log(
		`Access token valid ${formatRelative(token.accessTokenExpiresAt, now)}.`,
	);
	console.log(
		`Refresh token valid ${formatRelative(token.refreshTokenExpiresAt, now)}.`,
	);
	console.log(`Tokens stored in the ${keyring.backend} keyring.`);
	console.log(`Next: "local-books sync --full" to seed the mirror.`);
	return 0;
}
