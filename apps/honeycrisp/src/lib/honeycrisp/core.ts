import { attachEncryption } from '@epicenter/workspace';
import * as Y from 'yjs';
import { createHoneycrispActions, honeycrispTables } from '../workspace.js';

export function openHoneycrisp({ clientID }: { clientID?: number } = {}) {
	const ydoc = new Y.Doc({ guid: 'epicenter.honeycrisp', gc: false });
	if (clientID !== undefined) ydoc.clientID = clientID;
	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(ydoc, honeycrispTables);
	const kv = encryption.attachKv(ydoc, {});
	const actions = createHoneycrispActions(tables);
	return {
		ydoc,
		tables,
		kv,
		encryption,
		actions,
		batch: (fn: () => void) => ydoc.transact(fn),
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}
