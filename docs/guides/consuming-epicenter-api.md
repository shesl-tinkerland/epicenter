# Consuming the Epicenter API

> **Historical note.** Earlier drafts of this guide described a
> `createWorkspace(definition).withEncryption().withExtension(...)` builder
> chain, and later an owner factory that wrapped the encryption, local
> storage, and per-owner wipe paths behind a single object. Both shapes
> are gone. There is one pattern today: `createWorkspace()` builds the low-level
> bundle, `create<App>Workspace()` defines the app's shared isomorphic model,
> and `open<App>Browser()` attaches browser storage and sync inline.
>
> Rather than maintain two versions of the same narrative, this guide also
> points at the canonical sources:
>
> - **Quick Start**: [`packages/workspace/README.md`](../../packages/workspace/README.md)
> - **Multi-device sync**: [`packages/workspace/SYNC_ARCHITECTURE.md`](../../packages/workspace/SYNC_ARCHITECTURE.md)
> - **Production wiring**: `apps/fuji/src/lib/browser.ts` (inline composition with per-row child docs), `apps/fuji/src/lib/session.ts` (session glue), `apps/tab-manager/src/lib/session.svelte.ts` (browser extension auth binding)

## Overview

The hosted hub at `https://api.epicenter.so` handles auth, real-time sync, AI inference, and encryption key derivation. It runs on Cloudflare Workers with Durable Objects. Cloud sync enters through `/api/owners/:ownerId/rooms/:roomId` (the same path in both personal and team mode): a cloud doc is owned by the authenticated `ownerId` and addressed by its `ydoc.guid`, and the server resolves the room from the auth token. Browser apps and the workspace daemon both use this route.

On the client, `@epicenter/workspace` exposes the primitives directly: define your schema with `defineTable` / `defineKv`, call `createWorkspace({ id, keyring, tables, kv })` inside a per-app `create<App>Workspace()` helper, then attach `attachLocalStorage` and `openCollaboration` inside `open<App>Browser()`. Authenticate with `@epicenter/auth` and gate the workspace lifecycle on signed-in identity with `createSession` from `@epicenter/svelte`.

## Minimal cloud workspace shape

This snippet shows a signed-in cloud workspace. The client builds the sync URL with `roomWsUrl({ baseURL, ownerId, guid, deviceId })`; the server resolves the room from the auth token, so the client never names a workspaceId.

The per-app browser opener is the single source of truth for "how this app mounts in a browser." `createWorkspace` builds the typed bundle in one call; every other `attach*` step is visible top-to-bottom against `workspace.ydoc`.

```typescript
import {
	attachLocalStorage,
	createDeviceId,
	createWorkspace,
	defineActions,
	defineMutation,
	defineWorkspace,
	column,
	defineTable,
	openCollaboration,
	roomWsUrl,
	wipeLocalStorage,
} from '@epicenter/workspace';
import { createSession, type InferSignedIn, type SignedIn } from '@epicenter/svelte';
import Type from 'typebox';
import { auth } from './auth';

const MY_APP_ID = 'epicenter.my-app';

const myAppTables = {
	notes: defineTable({
		id: column.string(),
		title: column.string(),
	}),
};

function createMyAppWorkspace(opts: { keyring: SignedIn['keyring'] }) {
	const workspace = createWorkspace({
		id: MY_APP_ID,
		keyring: opts.keyring,
		tables: myAppTables,
		kv: {},
	});
	const actions = defineActions({
		notes_create: defineMutation({
			description: 'Create a note',
			input: Type.Object({ id: Type.String(), title: Type.String() }),
			handler: ({ id, title }) => {
				workspace.tables.notes.set({ id, title });
			},
		}),
	});

	return defineWorkspace({
		...workspace,
		actions,
	});
}

export function openMyAppBrowser({
	signedIn,
	deviceId,
}: {
	signedIn: SignedIn;
	deviceId: string;
}) {
	const workspace = createMyAppWorkspace({ keyring: signedIn.keyring });

	const idb = attachLocalStorage(workspace.ydoc, {
		server: signedIn.server,
		ownerId: signedIn.ownerId,
		keyring: signedIn.keyring,
	});
	const collab = openCollaboration(workspace.ydoc, {
		url: roomWsUrl({
			baseURL: signedIn.baseURL,
			ownerId: signedIn.ownerId,
			guid: workspace.ydoc.guid,
			deviceId,
		}),
		openWebSocket: signedIn.openWebSocket,
		onReconnectSignal: signedIn.onReconnectSignal,
		waitFor: idb.whenLoaded,
		actions: workspace.actions,
	});

	return defineWorkspace({
		...workspace,
		idb,
		collab,
		async wipe() {
			workspace[Symbol.dispose]();
			await Promise.all([idb.whenDisposed, collab.whenDisposed]);
			await wipeLocalStorage({
				server: signedIn.server,
				ownerId: signedIn.ownerId,
			});
		},
	});
}

export const session = createSession({
	auth,
	build: (signedIn) => {
		const workspace = openMyAppBrowser({
			signedIn,
			deviceId: createDeviceId({ storage: localStorage }),
		});
		return {
			...workspace,
			[Symbol.dispose]() {
				workspace[Symbol.dispose]();
			},
		};
	},
});

export type MyAppSignedIn = InferSignedIn<typeof session>;
```

The `ydoc.guid` is both the local IndexedDB key and the cloud room id. Namespace it to your app, for example `epicenter.my-app`, to avoid collisions when multiple apps share the same IndexedDB origin. The cloud sync route is `/api/owners/:ownerId/rooms/:roomId` in both modes, taking the room id straight from `ydoc.guid`; the server resolves the DO name `owners/${ownerId}/rooms/${room}` from the auth token, with no workspace lookup. In personal mode `ownerId === user.id`; in team mode `ownerId === 'team'`.

`createSession({ auth, build })` reconciles `auth.state` against the live workspace and hands `build` a `SignedIn` value shaped `{ server, baseURL, ownerId, keyring, openWebSocket, onReconnectSignal }`. `createWorkspace` reads `keyring` to derive per-table keys; `attachLocalStorage` reads `server` and `ownerId` to namespace the IndexedDB database under the owner prefix; `openCollaboration` uses `openWebSocket` to attach the bearer token at connection time and `onReconnectSignal` to react to auth changes. Sign-out disposes the workspace, and a same-owner identity refresh keeps the workspace mounted. A different owner from `/api/session` is rejected by auth before the workspace is reused.

`wipeLocalStorage({ server, ownerId })` is a free function that enumerates `indexedDB.databases()` and deletes every database under the owner's prefix. There is no per-app wipe helper to register; the prefix scan catches every encrypted IDB database the owner created on this profile, including per-row child docs.
