/**
 * Lazily open a write-capable QuickBooks client for the daemon's realm. The
 * agent action layer never holds QB credentials directly; instead the mount
 * hands the write tools this thunk. It reloads the token from the keyring on
 * each call, so it always starts from the newest persisted (possibly rotated)
 * credentials and stays out of the mount's synchronous `compose` path.
 */

import { Err, Ok, type Result } from 'wellcrafted/result';
import type { AppConfig } from '../config.ts';
import type { Keyring } from '../keyring.ts';
import { createQbClient, type QbClient } from '../qb-client.ts';
import { createTokenManager, loadToken } from '../token-manager.ts';

/** Opens a QB client for the realm, or a user-facing reason it cannot. */
export type OpenQbClient = () => Promise<Result<QbClient, string>>;

export function makeQbAccess({
	config,
	realmId,
	keyring,
	now,
}: {
	config: AppConfig;
	realmId: string;
	keyring: Keyring;
	now: () => number;
}): OpenQbClient {
	return async () => {
		const token = await loadToken(keyring, realmId);
		if (!token) {
			return Err(
				`No stored token for company ${realmId}. Run "local-books auth" on the host that runs this daemon.`,
			);
		}
		const tokens = createTokenManager({ config, keyring, token, now });
		return Ok(createQbClient({ config, realmId, tokens }));
	};
}
