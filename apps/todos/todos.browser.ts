import {
	attachBroadcastChannel,
	attachIndexedDb,
	defineWorkspace,
} from '@epicenter/workspace';
import { createTodos } from './todos';

export function openTodosBrowser() {
	const workspace = createTodos();
	const idb = attachIndexedDb(workspace.ydoc);
	attachBroadcastChannel(workspace.ydoc);

	return defineWorkspace({
		...workspace,
		idb,
		whenReady: idb.whenLoaded,
		async wipe() {
			workspace[Symbol.dispose]();
			await idb.whenDisposed;
			await idb.clearLocal();
		},
		[Symbol.dispose]() {
			workspace[Symbol.dispose]();
		},
	});
}

export type TodosBrowser = ReturnType<typeof openTodosBrowser>;
