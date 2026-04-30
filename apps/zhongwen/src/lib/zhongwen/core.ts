import { attachEncryption } from '@epicenter/workspace';
import * as Y from 'yjs';
import { zhongwenKv, zhongwenTables } from '../workspace/index.js';

export function openZhongwen({ clientID }: { clientID?: number } = {}) {
	const ydoc = new Y.Doc({ guid: 'epicenter.zhongwen', gc: false });
	if (clientID !== undefined) ydoc.clientID = clientID;
	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(ydoc, zhongwenTables);
	const kv = encryption.attachKv(ydoc, zhongwenKv);
	return {
		ydoc,
		tables,
		kv,
		encryption,
		batch: (fn: () => void) => ydoc.transact(fn),
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}
