import ms from 'ms';
import type { ParsedArgs } from '../cli.ts';
import { openBooksDb } from '../db.ts';
import { DEFAULT_ENTITIES, isKnownEntity } from '../entities.ts';
import type { OAuthDeps } from '../oauth.ts';
import { dbPath } from '../paths.ts';
import { createQbClient } from '../qb-client.ts';
import {
	runSyncLoop,
	type SyncAllOutcome,
	type SyncDeps,
	syncAll,
} from '../sync.ts';
import { createTokenManager, loadToken } from '../token-manager.ts';
import { resolveCompany } from './context.ts';

/** Print one sync pass: results to stdout, failures to stderr. */
function reportOutcome({ results, failures }: SyncAllOutcome): void {
	for (const r of results) {
		console.log(
			`${r.entity.padEnd(12)} ${r.mode.padEnd(11)} ${r.upserted} upserted, ${r.deleted} deleted` +
				`  cursor ${r.cursorBefore ?? '(none)'} -> ${r.cursorAfter}`,
		);
	}
	for (const f of failures) {
		console.error(`${f.entity}: FAILED — ${f.error.message}`);
	}
}

/**
 * Refresh the local mirror. Mode (FULL vs INCREMENTAL) is chosen per entity from
 * stored `_sync_state`; `--full` forces FULL; `--entity` narrows the set.
 * `--interval` keeps syncing on a loop until Ctrl-C.
 */
export async function runSync(args: ParsedArgs): Promise<number> {
	const { data: company, error } = resolveCompany(args);
	if (error !== null) {
		console.error(error);
		return 1;
	}
	const { config, realmId, keyring } = company;

	const entities = args.entities.length > 0 ? args.entities : config.entities;
	const unknown = entities.filter((name) => !isKnownEntity(name));
	if (unknown.length > 0) {
		console.error(
			`Unknown entities: ${unknown.join(', ')}. Known: ${DEFAULT_ENTITIES.join(', ')}.`,
		);
		return 1;
	}

	const token = await loadToken(keyring, realmId);
	if (!token) {
		console.error(
			`No stored token for company ${realmId}. Run "local-books auth".`,
		);
		return 1;
	}

	const now = () => Date.now();
	const log = (m: string) => console.error(m);
	const oauthDeps: OAuthDeps = { now, log };
	const tokens = createTokenManager({
		config,
		keyring,
		token,
		deps: oauthDeps,
	});
	const client = createQbClient({ config, realmId, tokens, log });
	const db = openBooksDb(dbPath(config.dataDir, realmId));
	const deps: SyncDeps = { db, client, config, now, log };

	// Looping mode: keep the mirror fresh until interrupted.
	if (args.intervalMs != null) {
		const controller = new AbortController();
		const stop = () => {
			console.error('\nstopping...');
			controller.abort();
		};
		process.on('SIGINT', stop);
		console.error(
			`Syncing ${entities.join(', ')} for company ${realmId} (${config.environment}) every ${ms(args.intervalMs)} — Ctrl-C to stop.`,
		);
		await runSyncLoop(deps, {
			forceFull: args.full,
			entities,
			intervalMs: args.intervalMs,
			signal: controller.signal,
			onPass: reportOutcome,
		});
		process.off('SIGINT', stop);
		db.close();
		return 0;
	}

	// Single pass.
	console.error(
		`Syncing ${entities.join(', ')} for company ${realmId} (${config.environment})${args.full ? ' [--full]' : ''}...`,
	);
	const outcome = await syncAll(deps, { forceFull: args.full, entities });
	db.close();
	reportOutcome(outcome);
	return outcome.failures.length > 0 ? 1 : 0;
}
