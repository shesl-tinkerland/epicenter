import { type } from 'arktype';

/**
 * One root keyring entry from `ENCRYPTION_SECRETS`.
 *
 * The `secret` string is raw deployment key material, usually generated with
 * `openssl rand -base64 32`. The version has the same one-byte limit as
 * encrypted blobs because it eventually becomes the key version in blob byte 1.
 */
export const RootKeyringEntry = type({
	version: '1 <= number.integer <= 255',
	secret: 'string',
});

/**
 * Non-empty root keyring.
 *
 * The parsed keyring is canonicalized by descending version so the first entry
 * is the current secret for new per-subject key derivations.
 */
export const RootKeyring = type([
	RootKeyringEntry,
	'...',
	RootKeyringEntry.array(),
]);

export type RootKeyringEntry = typeof RootKeyringEntry.infer;
export type RootKeyring = typeof RootKeyring.infer;

function parseRootKeyringEntry(entry: string): RootKeyringEntry {
	const separatorIndex = entry.indexOf(':');
	if (separatorIndex === -1) {
		throw new Error('Root keyring entry must use "version:secret" format');
	}
	const versionText = entry.slice(0, separatorIndex);
	const secret = entry.slice(separatorIndex + 1);
	if (versionText.length === 0) {
		throw new Error('Root keyring entry version is required');
	}
	if (secret.length === 0) {
		throw new Error('Root keyring entry secret is required');
	}
	const parsed = RootKeyringEntry({
		version: Number(versionText),
		secret,
	});
	if (parsed instanceof type.errors) {
		throw new Error(parsed.summary);
	}
	return parsed;
}

function sortRootKeyring(rootKeyring: RootKeyring): RootKeyring {
	return [...rootKeyring].sort(
		(left, right) => right.version - left.version,
	) as RootKeyring;
}

function assertNoDuplicateVersions(rootKeyring: RootKeyring): void {
	const seen = new Set<number>();
	for (const { version } of rootKeyring) {
		if (seen.has(version)) {
			throw new Error(`Duplicate root keyring version: ${version}`);
		}
		seen.add(version);
	}
}

/**
 * Parse `ENCRYPTION_SECRETS` using the shared `version:secret` grammar.
 *
 * Entries are separated by commas. Each entry splits on the first colon, so
 * secret values may contain colons but not commas. Duplicate versions are
 * rejected because one blob key version must identify exactly one secret.
 *
 * @example
 * ```typescript
 * const rootKeyring = parseRootKeyring('2:newBase64,1:oldBase64');
 * // [{ version: 2, secret: 'newBase64' }, { version: 1, secret: 'oldBase64' }]
 * ```
 */
export function parseRootKeyring(value: string): RootKeyring {
	if (value.length === 0) throw new Error('ENCRYPTION_SECRETS is required');
	const entries = value.split(',').map(parseRootKeyringEntry);
	const parsed = RootKeyring(entries);
	if (parsed instanceof type.errors) {
		throw new Error(parsed.summary);
	}
	assertNoDuplicateVersions(parsed);
	return sortRootKeyring(parsed);
}

/**
 * Format a root keyring back to canonical env-var text.
 *
 * The output is sorted by descending version to make the current secret visible
 * at the front of the string. This does not preserve input order by design.
 *
 * @example
 * ```typescript
 * formatRootKeyring([
 *   { version: 1, secret: 'oldBase64' },
 *   { version: 2, secret: 'newBase64' },
 * ]);
 * // "2:newBase64,1:oldBase64"
 * ```
 */
export function formatRootKeyring(rootKeyring: RootKeyring): string {
	const parsed = RootKeyring(rootKeyring);
	if (parsed instanceof type.errors) {
		throw new Error(parsed.summary);
	}
	assertNoDuplicateVersions(parsed);
	return sortRootKeyring(parsed)
		.map(({ version, secret }) => `${version}:${secret}`)
		.join(',');
}
