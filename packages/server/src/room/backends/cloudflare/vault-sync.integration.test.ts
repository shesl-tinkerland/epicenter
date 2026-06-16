/**
 * Wave 3 of the secret vault build: the last-mile proof.
 *
 * Waves 1 and 2 proved the crypto in isolation. This drives the WHOLE stack
 * through the real relay: a passphrase-derived keyring (wave 2) encrypts a secret
 * into the encrypted KV primitive (wave 1), the resulting Y.Doc update crosses
 * the actual `Room` Durable Object (the relay), a second client applies what the
 * relay forwarded and re-derives the key from the passphrase alone, and the
 * relay's persisted bytes are inspected to confirm it only ever held ciphertext.
 *
 * The vault is just a Y.Doc with its own guid on the same relay (a room id IS a
 * guid; rooms auto-create on connect), so there is no new server code: the relay
 * carries the vault exactly as it carries any other room, because value-level
 * encryption leaves the keys and CRDT structure plaintext.
 *
 * This is the test the throwaway spike could not write, because the spike modeled
 * the relay as raw `encodeStateAsUpdate` bytes. Here the bytes go through the
 * real relay.
 */

import { describe, expect, test } from 'bun:test';
import { createVaultKeyring, unlockVaultKeyring } from '@epicenter/encryption';
import {
	encodeSyncUpdate,
	handleSyncPayload,
	type SyncMessageType,
} from '@epicenter/sync';
import { createEncryptedYkvLww } from '@epicenter/workspace/shared/y-keyvalue/y-keyvalue-lww-encrypted';
import * as decoding from 'lib0/decoding';
import * as Y from 'yjs';
import {
	makeRoom,
	type StubWebSocket,
	toArrayBuffer,
	upgrade,
} from './test-harness.js';

/** Cheap Argon2id cost so the suite stays fast. Production uses far steeper parameters. */
const TEST_PARAMS = { t: 1, m: 8 * 1024, p: 1 } as const;

const PASSPHRASE = 'correct horse battery staple';
const SECRET = { apiKey: 'sk-live-do-not-leak-7f3a91' };
const KEY_NAME = 'providers.openai';
/** The vault's own room: a distinct Y.Doc guid, scoped to the same owner. */
const VAULT_GUID = 'whispering:vault';

type Secret = typeof SECRET;

function bytesInclude(bytes: Uint8Array, text: string): boolean {
	return Buffer.from(bytes).includes(Buffer.from(text, 'utf8'));
}

/** Pull the binary (sync) frames the relay forwarded to a socket. */
function binaryFramesAfter(ws: StubWebSocket, before: number): Uint8Array[] {
	return ws.sent
		.slice(before)
		.filter((frame): frame is Uint8Array => frame instanceof Uint8Array);
}

/** Apply a relay-forwarded sync frame to a local doc, the way a client would. */
function applySyncFrame(doc: Y.Doc, frame: Uint8Array): void {
	const decoder = decoding.createDecoder(frame);
	const syncType = decoding.readVarUint(decoder) as SyncMessageType;
	const payload = decoding.readVarUint8Array(decoder);
	handleSyncPayload({ syncType, payload, doc, origin: 'remote' });
}

/** Every update blob the relay persisted to its room storage. */
function persistedUpdates(ctx: {
	storage: {
		sql: { exec(q: string): { toArray(): Array<{ data: ArrayBuffer }> } };
	};
}): Uint8Array[] {
	return ctx.storage.sql
		.exec('SELECT data FROM updates')
		.toArray()
		.map((row) => new Uint8Array(row.data));
}

describe('secret vault syncs through the real relay', () => {
	test('a passphrase-encrypted secret reaches a second device the relay cannot read', async () => {
		const { metadata, keyring } = createVaultKeyring(PASSPHRASE, {
			params: TEST_PARAMS,
		});

		const { room, ctx } = await makeRoom();
		const wsA = await upgrade(room, 'device-a');
		const wsB = await upgrade(room, 'device-b');
		const beforeB = wsB.sent.length;

		// Device A: write the secret into the vault and push it to the relay.
		const docA = new Y.Doc({ guid: VAULT_GUID });
		const vaultA = createEncryptedYkvLww<Secret>(docA, 'secrets');
		vaultA.activateEncryption(keyring);
		vaultA.set(KEY_NAME, SECRET);
		await room.webSocketMessage(
			wsA,
			toArrayBuffer(
				encodeSyncUpdate({ update: Y.encodeStateAsUpdateV2(docA) }),
			),
		);

		// The relay forwarded exactly the encrypted bytes to device B.
		const forwarded = binaryFramesAfter(wsB, beforeB);
		expect(forwarded.length).toBeGreaterThan(0);

		// Device B: apply what the relay forwarded, re-derive the key from the
		// passphrase alone, and read the secret back.
		const docB = new Y.Doc({ guid: VAULT_GUID });
		for (const frame of forwarded) applySyncFrame(docB, frame);
		const keyringB = unlockVaultKeyring(PASSPHRASE, metadata);
		expect(keyringB).not.toBeNull();
		const vaultB = createEncryptedYkvLww<Secret>(docB, 'secrets');
		vaultB.activateEncryption(keyringB!);
		expect(vaultB.get(KEY_NAME)).toEqual(SECRET);

		// The relay only ever held ciphertext: the key name (CRDT structure) is
		// visible so it can sync and compact, but the secret value is not.
		const stored = persistedUpdates(ctx);
		expect(stored.length).toBeGreaterThan(0);
		for (const blob of [...stored, ...forwarded]) {
			expect(bytesInclude(blob, SECRET.apiKey)).toBe(false);
		}
		expect(stored.some((blob) => bytesInclude(blob, KEY_NAME))).toBe(true);
	});

	test('a device with the synced ciphertext but the wrong passphrase cannot read the secret', async () => {
		const { metadata, keyring } = createVaultKeyring(PASSPHRASE, {
			params: TEST_PARAMS,
		});

		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'device-a');
		const wsB = await upgrade(room, 'device-b');
		const beforeB = wsB.sent.length;

		const docA = new Y.Doc({ guid: VAULT_GUID });
		const vaultA = createEncryptedYkvLww<Secret>(docA, 'secrets');
		vaultA.activateEncryption(keyring);
		vaultA.set(KEY_NAME, SECRET);
		await room.webSocketMessage(
			wsA,
			toArrayBuffer(
				encodeSyncUpdate({ update: Y.encodeStateAsUpdateV2(docA) }),
			),
		);

		// Device B holds the synced ciphertext but only a wrong passphrase: no
		// keyring can be derived, so there is nothing to decrypt with.
		const docB = new Y.Doc({ guid: VAULT_GUID });
		for (const frame of binaryFramesAfter(wsB, beforeB))
			applySyncFrame(docB, frame);
		expect(unlockVaultKeyring('the wrong passphrase', metadata)).toBeNull();
	});
});
