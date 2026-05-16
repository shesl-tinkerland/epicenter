import {
	base64ToBytes,
	deriveWorkspaceKey,
	type SubjectKeyring,
	type WorkspaceKeyring,
} from '@epicenter/encryption';

/**
 * Derive the per-workspace keyring from the authenticated subject keyring.
 *
 * `SubjectKeyring` is server-issued owner material. Workspace encryption does
 * not use it directly; each entry is narrowed with the workspace id so the
 * same subject gets independent keys for different Y.Doc roots.
 */
export function deriveWorkspaceKeyring(
	keyring: SubjectKeyring,
	workspaceId: string,
): WorkspaceKeyring {
	const workspaceKeyring: WorkspaceKeyring = new Map();
	for (const { version, subjectKeyBase64 } of keyring) {
		const subjectKey = base64ToBytes(subjectKeyBase64);
		workspaceKeyring.set(version, deriveWorkspaceKey(subjectKey, workspaceId));
	}
	return workspaceKeyring;
}
