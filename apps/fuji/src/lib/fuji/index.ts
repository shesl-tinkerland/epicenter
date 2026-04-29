import { attachEncryption } from '@epicenter/workspace';
import * as Y from 'yjs';
import { createFujiActions, fujiTables } from '../workspace.js';

export function openFuji() {
	const ydoc = new Y.Doc({ guid: 'epicenter.fuji', gc: false });
	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(ydoc, fujiTables);
	const kv = encryption.attachKv(ydoc, {});
	const actions = createFujiActions(tables);
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
