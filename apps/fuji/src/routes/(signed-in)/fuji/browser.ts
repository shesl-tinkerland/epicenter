import { APP_URLS } from '@epicenter/constants/vite';
import {
	createFujiActions,
	type EntryId,
	openFujiWorkspace,
} from '@epicenter/fuji';
import {
	attachRichText,
	createDisposableCache,
	DateTimeString,
	type LocalOwner,
	type OpenWebSocket,
	onLocalUpdate,
	openCollaboration,
	roomWsUrl,
} from '@epicenter/workspace';
import * as Y from 'yjs';

export function openFujiBrowser({
	owner,
	replicaId,
	openWebSocket,
}: {
	owner: LocalOwner;
	replicaId: string;
	openWebSocket?: OpenWebSocket;
}) {
	const workspace = openFujiWorkspace(owner.attachEncryption);
	const { ydoc: rootYdoc, tables, kv } = workspace;

	const idb = owner.attachIndexedDb(rootYdoc);
	owner.attachBroadcastChannel(rootYdoc);

	const entryContentDocs = createDisposableCache((entryId: EntryId) => {
		const ydoc = new Y.Doc({
			guid: workspace.entryContentDocGuid(entryId),
			gc: false,
		});
		const body = attachRichText(ydoc);
		const childIdb = owner.attachIndexedDb(ydoc);
		owner.attachBroadcastChannel(ydoc);
		const childSync = openCollaboration(ydoc, {
			url: roomWsUrl(APP_URLS.API, ydoc.guid),
			waitFor: childIdb.whenLoaded,
			openWebSocket,
			replicaId,
			actions: {},
		});

		onLocalUpdate(ydoc, () => {
			tables.entries.update(entryId, {
				updatedAt: DateTimeString.now(),
			});
		});

		return {
			ydoc,
			body,
			idb: childIdb,
			sync: childSync,
			/**
			 * child disposer rejections do not propagate; bundle.wipe() relies on
			 * IDB's deleteDatabase native blocking as belt-and-suspenders for
			 * storage deletion.
			 */
			[Symbol.dispose]() {
				ydoc.destroy();
			},
		};
	});

	const actions = createFujiActions(tables);
	const collaboration = openCollaboration(rootYdoc, {
		url: roomWsUrl(APP_URLS.API, rootYdoc.guid),
		waitFor: idb.whenLoaded,
		openWebSocket,
		replicaId,
		actions,
	});

	return {
		ydoc: rootYdoc,
		tables,
		kv,
		batch: workspace.batch,
		idb,
		entryContentDocs,
		collaboration,
		async wipe() {
			const fallbackGuids = [
				rootYdoc.guid,
				...tables.entries
					.getAllValid()
					.map((entry) => workspace.entryContentDocGuid(entry.id)),
			];
			entryContentDocs[Symbol.dispose]();
			rootYdoc.destroy();
			await Promise.all([idb.whenDisposed, collaboration.whenDisposed]);
			await owner.wipeLocalYjsData(fallbackGuids);
		},
		[Symbol.dispose]() {
			entryContentDocs[Symbol.dispose]();
			rootYdoc.destroy();
		},
	};
}

export type FujiBrowser = ReturnType<typeof openFujiBrowser>;
