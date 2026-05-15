import { env } from 'cloudflare:workers';
import {
	deriveSubjectKeyring as deriveSubjectKeyringFromRoot,
	parseRootKeyring,
	type RootKeyring,
	type SubjectKeyring,
} from '@epicenter/encryption';

let rootKeyring: RootKeyring;
try {
	rootKeyring = parseRootKeyring(env.ENCRYPTION_SECRETS);
} catch (error) {
	throw new Error(
		`ENCRYPTION_SECRETS is missing or malformed. Expected format: "2:base64Secret2,1:base64Secret1" (comma-separated version:secret pairs). Generate a secret with: openssl rand -base64 32\n\nValidation error:\n${error instanceof Error ? error.message : String(error)}`,
	);
}

/**
 * Derive the per-subject keyring attached to Epicenter auth-session responses.
 *
 * The API owns env access and fail-fast worker startup. `@epicenter/encryption`
 * owns parsing and HKDF derivation, keeping workspace encryption separate from
 * Better Auth's cookie and token secrets.
 */
export async function deriveSubjectKeyring(
	subject: string,
): Promise<SubjectKeyring> {
	return deriveSubjectKeyringFromRoot({
		rootKeyring,
		subject,
	});
}
