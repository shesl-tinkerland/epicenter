import { createMachineAuthClient, requireSignedIn } from '@epicenter/auth/node';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { attachSync, type ProjectDir, toWsUrl } from '@epicenter/workspace';
import {
	attachYjsLogReader,
	findEpicenterDir,
	hashClientId,
	yjsPath,
} from '@epicenter/workspace/node';
import { openZhongwen as openZhongwenDoc } from './index.js';

export async function openZhongwen({
	projectDir = findEpicenterDir(),
	clientID = hashClientId(Bun.main),
}: {
	projectDir?: ProjectDir;
	clientID?: number;
}) {
	const auth = await createMachineAuthClient();
	const doc = openZhongwenDoc({
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

	return { ...doc, yjsLog, sync };
}
