import { createMachineAuthClient, requireSignedIn } from '@epicenter/auth/node';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { attachSync, type ProjectDir, toWsUrl } from '@epicenter/workspace';
import {
	attachYjsLogReader,
	findEpicenterDir,
	hashClientId,
	yjsPath,
} from '@epicenter/workspace/node';
import { openHoneycrisp as openHoneycrispDoc } from './index.js';

export async function openHoneycrisp({
	projectDir = findEpicenterDir(),
	clientID = hashClientId(Bun.main),
}: {
	projectDir?: ProjectDir;
	clientID?: number;
}) {
	const auth = await createMachineAuthClient();
	const doc = openHoneycrispDoc({
		clientID,
		encryptionKeys: () => requireSignedIn(auth).encryptionKeys,
	});
	const yjsLog = attachYjsLogReader(doc.ydoc, {
		filePath: yjsPath(projectDir, doc.ydoc.guid),
	});
	const sync = attachSync(doc, {
		url: toWsUrl(`${EPICENTER_API_URL}/workspaces/${doc.ydoc.guid}`),
		bearerToken: () => auth.bearerToken,
	});
	const rpc = sync.attachRpc(doc.actions);

	return { ...doc, yjsLog, sync, rpc };
}
