import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { type Static, Type } from 'typebox';
import { Value } from 'typebox/value';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { AppConfig } from './config.ts';
import { companiesFilePath } from './paths.ts';

/**
 * Tracks which QuickBooks companies (`realmId`s) have been authenticated, so
 * `sync` / `status` know which mirror to operate on without the user repeating
 * `--realm` every time. The keyring holds the tokens; this is just the index.
 */
const CompaniesSchema = Type.Object({
	realms: Type.Array(Type.String()),
	defaultRealm: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
export type Companies = Required<Static<typeof CompaniesSchema>>;

export function readCompanies(dataDir: string): Companies {
	try {
		const parsed: unknown = JSON.parse(
			readFileSync(companiesFilePath(dataDir), 'utf8'),
		);
		if (!Value.Check(CompaniesSchema, parsed))
			return { realms: [], defaultRealm: null };
		return { realms: parsed.realms, defaultRealm: parsed.defaultRealm ?? null };
	} catch {
		return { realms: [], defaultRealm: null };
	}
}

/** Record a freshly-authenticated company and make it the default. */
export function recordCompany(dataDir: string, realmId: string): void {
	const current = readCompanies(dataDir);
	const realms = current.realms.includes(realmId)
		? current.realms
		: [...current.realms, realmId];
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(
		companiesFilePath(dataDir),
		JSON.stringify({ realms, defaultRealm: realmId }, null, 2),
	);
}

/**
 * Pick the company to act on: explicit `--realm`/env override, else the recorded
 * default, else the only authenticated company. Ambiguity is an error, not a
 * silent guess.
 */
export function resolveRealm(config: AppConfig): Result<string, string> {
	if (config.realmOverride) return Ok(config.realmOverride);

	const { realms, defaultRealm } = readCompanies(config.dataDir);
	if (defaultRealm) return Ok(defaultRealm);
	if (realms.length === 1) return Ok(realms[0] as string);
	if (realms.length === 0) {
		return Err('No authenticated company. Run "local-books auth" first.');
	}
	return Err(
		`Multiple companies authenticated (${realms.join(', ')}). Pass --realm <realmId>.`,
	);
}
