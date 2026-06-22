import { Err, Ok, type Result } from 'wellcrafted/result';
import type { ParsedArgs } from '../cli.ts';
import { resolveRealm } from '../companies.ts';
import { type AppConfig, loadConfig } from '../config.ts';
import { createKeyring, type Keyring } from '../keyring.ts';

/** Human-friendly "in 42m" / "3m ago" for the auth and status commands. */
export function formatRelative(targetIso: string, now: number): string {
	const deltaMs = Date.parse(targetIso) - now;
	const mins = Math.round(Math.abs(deltaMs) / 60000);
	const unit =
		mins < 60
			? `${mins}m`
			: mins < 60 * 24
				? `${Math.round(mins / 60)}h`
				: `${Math.round(mins / (60 * 24))}d`;
	return deltaMs >= 0 ? `in ${unit}` : `${unit} ago`;
}

/** The company that sync/status operate on: config, resolved realm, its keyring. */
export type CompanyContext = {
	config: AppConfig;
	realmId: string;
	keyring: Keyring;
};

/**
 * Resolve the target company shared by `sync` and `status`: load config, pick
 * the realm (explicit flag, recorded default, or the sole authenticated one),
 * and open its keyring. Returns a user-facing error string when the realm is
 * ambiguous or none is authenticated.
 */
export function resolveCompany(
	args: ParsedArgs,
): Result<CompanyContext, string> {
	const config = loadConfig({
		dataDir: args.dataDir,
		environment: args.environment,
		realm: args.realm,
	});
	const { data: realmId, error } = resolveRealm(config);
	if (error !== null) return Err(error);
	return Ok({ config, realmId, keyring: createKeyring(config) });
}
