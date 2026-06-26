/**
 * First-boot instance token: mint, persist, and reuse the self-host star's
 * single-user bearer (ADR-0070, ADR-0071, ADR-0072).
 *
 * A solo self-hosted box has no Google OAuth app and no member allowlist; its
 * one operator authenticates against their own origin with a static bearer
 * token. This module is where that token comes from. The resolution order is
 * the canonical zero-config-but-secure first-boot pattern (code-server, n8n,
 * Jupyter, Vault operator init all do the same shape):
 *
 *   1. `INSTANCE_TOKEN` env set    -> use it verbatim (12-factor / container
 *      secret injection; the box never writes a file).
 *   2. `<dataDir>/instance-token`  -> reuse the token minted on a prior boot, so
 *      a restart never invalidates the operator's pasted credential.
 *   3. neither                     -> mint `randomBytes(32).base64url`, write it
 *      0600, and report `minted` so the entry can print it once.
 *
 * Bun-only: minting needs `node:crypto` and the file needs disk, neither of
 * which the Worker entry has. The constant-time compare against this token lives
 * in `@epicenter/server`'s portable resolver (Web Crypto, no `node:`); only the
 * source of the token is host-specific, so it stays here.
 *
 * The one real footgun is an ephemeral `DATA_DIR`: if the operator forgets to
 * persist it (a recreated container, a tmpfs), step 3 silently re-mints on every
 * boot and breaks the pasted token. The entry's boot banner names the file path
 * so a re-mint is at least visible; durable `DATA_DIR` is the operator's job.
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Resolve the self-host instance token, minting and persisting one on first boot.
 *
 * `envToken` wins and is never written to disk (the operator owns it). Otherwise
 * an existing `<dataDir>/instance-token` is reused, or a fresh 32-byte token is
 * minted, written 0600, and flagged `minted: true` so the caller can print it
 * once. `path` is always returned so the entry can tell the operator where the
 * credential lives.
 */
export function loadOrMintInstanceToken(options: {
	dataDir: string;
	envToken?: string;
}): { token: string; minted: boolean; path: string } {
	const path = join(options.dataDir, 'instance-token');
	if (options.envToken) return { token: options.envToken, minted: false, path };
	if (existsSync(path)) {
		return { token: readFileSync(path, 'utf8').trim(), minted: false, path };
	}
	const token = randomBytes(32).toString('base64url');
	writeFileSync(path, token, { mode: 0o600 });
	chmodSync(path, 0o600); // belt-and-suspenders if umask widened the create mode
	return { token, minted: true, path };
}
