import { attachEncryption } from '@epicenter/workspace';
import * as Y from 'yjs';
import { opensidianTables } from '../workspace/definition.js';

export function openOpensidian({ clientID }: { clientID?: number } = {}) {
	const ydoc = new Y.Doc({ guid: 'epicenter.opensidian', gc: false });
	if (clientID !== undefined) ydoc.clientID = clientID;
	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(ydoc, opensidianTables);
	const kv = encryption.attachKv(ydoc, {});
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
