import { existsSync } from 'node:fs';
import type { ParsedArgs } from '../cli.ts';
import { openBooksDb } from '../db.ts';
import { entityDef } from '../entities.ts';
import { dbPath } from '../paths.ts';
import { loadToken } from '../token-manager.ts';
import { isAccessTokenExpired, isRefreshTokenExpired } from '../tokens.ts';
import { formatRelative, resolveCompany } from './context.ts';

/** Report token state and the per-entity mirror state (cursor, counts). */
export async function runStatus(args: ParsedArgs): Promise<number> {
	const { data: company, error } = resolveCompany(args);
	if (error !== null) {
		console.error(error);
		return 1;
	}
	const { config, realmId, keyring } = company;

	const token = await loadToken(keyring, realmId);
	const now = Date.now();

	console.log(`Company:      ${realmId}`);
	console.log(`Environment:  ${config.environment}`);
	console.log(`Data dir:     ${config.dataDir}`);
	console.log(`Keyring:      ${keyring.backend}`);

	if (!token) {
		console.log(`Token:        none — run "local-books auth"`);
	} else {
		const access = isAccessTokenExpired(token, now, 0) ? 'EXPIRED' : 'valid';
		const refresh = isRefreshTokenExpired(token, now) ? 'EXPIRED' : 'valid';
		console.log(
			`Token:        access ${access} (${formatRelative(token.accessTokenExpiresAt, now)}), ` +
				`refresh ${refresh} (${formatRelative(token.refreshTokenExpiresAt, now)})`,
		);
	}

	const path = dbPath(config.dataDir, realmId);
	if (!existsSync(path)) {
		console.log(
			`Mirror:       not created yet — run "local-books sync --full"`,
		);
		return 0;
	}

	const db = openBooksDb(path);
	console.log(`Schema:       v${db.getMeta('schema_version')}`);
	console.log('');
	console.log(
		`${'Entity'.padEnd(12)} ${'Rows'.padStart(7)} ${'Deleted'.padStart(8)}  ${'Cursor (changedSince)'.padEnd(26)} Last full pull`,
	);
	for (const name of config.entities) {
		const s = db.entityStatus(entityDef(name));
		console.log(
			`${name.padEnd(12)} ${String(s.rows).padStart(7)} ${String(s.deleted).padStart(8)}  ` +
				`${(s.cdcCursor ?? '-').padEnd(26)} ${s.lastFullPullAt ?? '-'}`,
		);
	}
	db.close();
	return 0;
}
