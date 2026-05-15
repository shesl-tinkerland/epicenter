import {
	base64ToBytes,
	deriveWorkspaceKey,
	type SubjectKeyring,
} from '@epicenter/encryption';

/**
 * Derive a versioned HKDF keyring for a workspace from the owner's subject
 * keyring.
 * Each version maps to a per-workspace key, used to activate encrypted stores
 * and to seed the encrypted IndexedDB provider.
 */
export function deriveWorkspaceKeyring(
	keyring: SubjectKeyring,
	workspaceId: string,
): Map<number, Uint8Array> {
	const workspaceKeyring = new Map<number, Uint8Array>();
	for (const { version, subjectKeyBase64 } of keyring) {
		const subjectKey = base64ToBytes(subjectKeyBase64);
		workspaceKeyring.set(version, deriveWorkspaceKey(subjectKey, workspaceId));
	}
	return workspaceKeyring;
}
