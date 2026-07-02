# Consuming the Epicenter API

> **Historical note.** Earlier drafts of this guide described a
> `createWorkspace(definition).withEncryption().withExtension(...)` builder
> chain, and later an owner factory that wrapped the encryption, local
> storage, and per-owner wipe paths behind a single object. Both shapes
> are gone. There is one pattern today: `createWorkspace()` builds the low-level
> bundle, `create<App>()` defines the app's shared isomorphic model,
> and `open<App>Browser()` attaches browser storage and sync inline.
>
> Rather than maintain two versions of the same narrative, this guide also
> points at the canonical sources:
>
> - **Quick Start**: [`packages/workspace/README.md`](../../packages/workspace/README.md)
> - **Multi-node sync**: [`packages/workspace/SYNC_ARCHITECTURE.md`](../../packages/workspace/SYNC_ARCHITECTURE.md)
> - **Production wiring**: `apps/honeycrisp/src/lib/workspace/browser.ts` (inline composition with per-row child docs), `apps/honeycrisp/src/lib/honeycrisp.ts` (boot singleton), `apps/tab-manager/src/lib/session.svelte.ts` (browser extension auth binding)

## Overview

The hosted hub at `https://api.epicenter.so` handles auth, real-time sync, and AI inference. It runs on Cloudflare Workers with Durable Objects. Cloud sync enters through `/api/owners/:ownerId/rooms/:roomId` (the same path in personal cloud and self-hosted instance deployments): a cloud doc is owned by the resolved `ownerId` and addressed by its `ydoc.guid`, and the server resolves the room from the auth token. Browser apps and the workspace daemon both use this route.

On the client, `@epicenter/workspace` exposes the primitives directly: define your schema with `defineTable` / `defineKv`, call `createWorkspace({ id, tables, kv })` inside a per-app `create<App>()` helper, then attach `attachLocalStorage` and `openCollaboration` inside `open<App>Browser()`. Authenticate with `@epicenter/auth` and gate the workspace lifecycle on signed-in identity with `createSession` from `@epicenter/svelte`.

## Minimal cloud workspace shape

This snippet shows a signed-in cloud workspace. The client builds the sync URL with `roomWsUrl({ baseURL, ownerId, guid, nodeId })`; the server resolves the room from the auth token, so the client never names a workspaceId.

The per-app browser opener is the single source of truth for "how this app mounts in a browser." `createWorkspace` builds the typed bundle in one call; every other `attach*` step is visible top-to-bottom against `workspace.ydoc`.

```typescript
import { field } from '@epicenter/field';
import {
	attachLocalStorage,
	createNodeId,
	createWorkspace,
	defineActions,
	defineMutation,
	defineWorkspace,
	defineTable,
	openCollaboration,
	roomWsUrl,
	wipeLocalStorage,
} from '@epicenter/workspace';
import { createSession, type InferSignedIn, type SignedIn } from '@epicenter/svelte/auth';
import Type from 'typebox';
import { auth } from './auth';

const MY_APP_ID = 'epicenter.my-app';

const myAppTables = {
	notes: defineTable({
		id: field.string(),
		title: field.string(),
	}),
};

function createMyApp() {
	const workspace = createWorkspace({
		id: MY_APP_ID,
		tables: myAppTables,
		kv: {},
	});

	return defineWorkspace({
		...workspace,
		actions: defineActions({
			notes_create: defineMutation({
				description: 'Create a note',
				input: Type.Object({ id: Type.String(), title: Type.String() }),
				handler: ({ id, title }) => {
					workspace.tables.notes.set({ id, title });
				},
			}),
		}),
		[Symbol.dispose]() {
			workspace[Symbol.dispose]();
		},
	});
}

export function openMyAppBrowser({
	signedIn,
	nodeId,
}: {
	signedIn: SignedIn;
	nodeId: string;
}) {
	const workspace = createMyApp();

	const idb = attachLocalStorage(workspace.ydoc, {
		server: signedIn.server,
		ownerId: signedIn.ownerId,
	});
	const collab = openCollaboration(workspace.ydoc, {
		url: roomWsUrl({
			baseURL: signedIn.baseURL,
			ownerId: signedIn.ownerId,
			guid: workspace.ydoc.guid,
			nodeId,
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
			nodeId: createNodeId({ storage: localStorage }),
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

The `ydoc.guid` is both the local IndexedDB key and the cloud room id. Namespace it to your app, for example `epicenter.my-app`, to avoid collisions when multiple apps share the same IndexedDB origin. The cloud sync route is `/api/owners/:ownerId/rooms/:roomId` in both personal cloud and self-hosted instance deployments, taking the room id straight from `ydoc.guid`; the server resolves the DO name `owners/${ownerId}/rooms/${room}` from the auth token, with no workspace lookup. In the personal cloud `ownerId === user.id`; on a self-hosted instance `ownerId === 'instance'`.

`createSession({ auth, build })` reconciles `auth.state` against the live workspace and hands `build` a `SignedIn` value shaped `{ server, baseURL, ownerId, openWebSocket, onReconnectSignal }`. `attachLocalStorage` reads `server` and `ownerId` to namespace the IndexedDB database under the owner prefix; `openCollaboration` uses `openWebSocket` to attach the bearer token at connection time and `onReconnectSignal` to react to auth changes. Sign-out disposes the workspace, and a same-owner identity refresh keeps the workspace mounted. A different owner from `/api/session` is rejected by auth before the workspace is reused.

`wipeLocalStorage({ server, ownerId })` is a free function that enumerates `indexedDB.databases()` and deletes every database under the owner's prefix. There is no per-app wipe helper to register; the prefix scan catches every IDB database the owner created on this profile, including per-row child docs.
