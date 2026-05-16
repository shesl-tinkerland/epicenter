# Consuming the Epicenter API

> **Historical note.** The long-form version of this guide described a
> `createWorkspace(definition).withEncryption().withExtension('persistence', ...).withExtension('sync', ...)`
> builder chain. That API is gone. There is one pattern today: a user-owned
> document factory, with every attachment (`attachTables`, `attachIndexedDb`,
> `attachEncryption`, etc.) composed inline plus the `openCollaboration`
> primitive that wraps sync, presence, RPC, and the peers surface in one call.
>
> Rather than maintain two versions of the same narrative, this guide now
> points at the canonical sources:
>
> - **Quick Start**: [`packages/workspace/README.md`](../../packages/workspace/README.md)
> - **Multi-device sync**: [`packages/workspace/SYNC_ARCHITECTURE.md`](../../packages/workspace/SYNC_ARCHITECTURE.md)
> - **Production wiring**: `apps/tab-manager/src/lib/tab-manager/client.ts` (browser extension auth binding), `apps/tab-manager/src/lib/tab-manager/extension.ts` (encryption + IndexedDB + WebSocket + BroadcastChannel), `apps/fuji/src/routes/(signed-in)/fuji/browser.ts` (per-row content docs)

## Overview

The hosted hub at `https://api.epicenter.so` handles auth, real-time sync, AI inference, and encryption key derivation. It runs on Cloudflare Workers with Durable Objects; each user gets isolated DOs for their workspaces and documents. There is no shared state between accounts.

On the client, `@epicenter/workspace` provides the primitives: define your schema with `defineTable` / `defineKv`, compose a live document by creating a `Y.Doc` and calling `attach*`, authenticate with `@epicenter/auth`, and gate the workspace lifecycle on signed-in identity with `createSession` from `@epicenter/svelte`.

## Minimal end-to-end shape

```typescript
import {
	createReplicaId,
	defineTable,
	type LocalOwner,
	openCollaboration,
	roomWsUrl,
} from '@epicenter/workspace';
import { createSession, type InferSignedIn } from '@epicenter/svelte';
import * as Y from 'yjs';
import { type } from 'arktype';
import { auth } from './auth';

const appTables = {
	notes: defineTable(
		type({
			id: 'string',
			title: 'string',
			_v: '1',
		}),
	),
};

function openMyAppDoc({ owner }: { owner: LocalOwner }) {
	const ydoc = new Y.Doc({ guid: 'epicenter.my-app', gc: false });
	const encryption = owner.attachEncryption(ydoc);
	const tables = encryption.attachTables(appTables);
	const kv = encryption.attachKv({});
	return { ydoc, encryption, tables, kv };
}

function openMyApp({
	owner,
	replicaId,
	openWebSocket,
}: {
	owner: LocalOwner;
	replicaId: string;
	openWebSocket?: (
		url: string | URL,
		protocols?: string[],
	) => WebSocket | Promise<WebSocket>;
}) {
	const doc = openMyAppDoc({ owner });
	const idb = owner.attachIndexedDb(doc.ydoc);
	owner.attachBroadcastChannel(doc.ydoc);

	const collaboration = openCollaboration(doc.ydoc, {
		url: roomWsUrl('https://api.epicenter.so', doc.ydoc.guid),
		openWebSocket,
		waitFor: idb.whenLoaded,
		replicaId,
		actions: {},
	});

	return {
		...doc,
		idb,
		collaboration,
		whenLoaded: idb.whenLoaded,
		async wipe() {
			doc.ydoc.destroy();
			await collaboration.whenDisposed;
			await idb.whenDisposed;
			await owner.wipeLocalYjsData([doc.ydoc.guid]);
		},
		[Symbol.dispose]() {
			doc.ydoc.destroy();
		},
	};
}

export const session = createSession({
	auth,
	build: ({ owner }) => {
		const workspace = openMyApp({
			owner,
			replicaId: createReplicaId({ storage: localStorage }),
			openWebSocket: auth.openWebSocket,
		});
		return {
			workspace,
			[Symbol.dispose]() {
				workspace[Symbol.dispose]();
			},
		};
	},
});

export type MyAppSignedIn = InferSignedIn<typeof session>;
```

The `ydoc.guid` becomes the sync room name. Namespace it to your app, for example `epicenter.my-app`, to avoid collisions when multiple apps share the same IndexedDB origin.
For authenticated browser workspaces, `createSession` gives app code a `LocalOwner`. The owner hides the subject to owner translation and scopes local IndexedDB, BroadcastChannel, and wipe paths for the signed-in subject.
`createSession` reconciles `auth.state` against the live workspace: sign-out disposes the workspace, and same-subject identity updates keep the workspace mounted. A different subject from `/api/me` is rejected by auth before the workspace is reused. Auth-bound callbacks still read `auth.state` at their own boundaries: sync can see refreshed bearer tokens on connection attempts, while encrypted stores keep the keyring they derived when they were attached.
