/**
 * Minimal fixture: one daemon route with inline `defineQuery` /
 * `defineMutation` nodes grouped under `actions:`. No sqlite or encryption.
 * The CLI walks `workspace.actions`, so CLI paths are
 * `demo.counter.{get,increment,set}`.
 */

import {
	defineMutation,
	defineQuery,
	type AwarenessAttachment,
	type PeerAwarenessSchema,
	type RemoteClient,
	type SyncAttachment,
} from '@epicenter/workspace';
import { defineConfig } from '@epicenter/workspace/daemon';
import Type from 'typebox';
import * as Y from 'yjs';

const ydoc = new Y.Doc({ guid: 'epicenter.demo' });
const state = ydoc.getMap<number>('state');
state.set('count', 0);

const sync = {
	whenConnected: Promise.resolve(),
	status: { phase: 'connected' },
	onStatusChange: () => () => {},
	reconnect() {},
	[Symbol.asyncDispose]: async () => {},
	attachRpc: () => ({ rpc: async () => ({ data: null, error: null }) }),
} as unknown as SyncAttachment;

const awareness = {
	peers: () => new Map(),
	observe: () => () => {},
} as unknown as AwarenessAttachment<PeerAwarenessSchema>;

const remote = {
	actions: () => ({}),
	describe: async () => ({ data: {}, error: null }),
	invoke: async () => ({
		error: {
			name: 'PeerNotFound',
			message: 'no peer matches peer id "missing"',
			peerTarget: 'missing',
			sawPeers: false,
			waitMs: 0,
		},
		data: null,
	}),
} as unknown as RemoteClient;

export const demo = {
	workspaceId: ydoc.guid,
	actions: {
		counter: {
			get: defineQuery({
				description: 'Read the current counter value',
				handler: () => state.get('count') ?? 0,
			}),
			increment: defineMutation({
				description: 'Increment the counter by one',
				handler: () => {
					const next = (state.get('count') ?? 0) + 1;
					state.set('count', next);
					return next;
				},
			}),
			set: defineMutation({
				description: 'Overwrite the counter value',
				input: Type.Object({ value: Type.Number() }),
				handler: ({ value }: { value: number }) => {
					state.set('count', value);
					return value;
				},
			}),
		},
	},
	awareness,
	sync,
	remote,
	async [Symbol.asyncDispose]() {
		ydoc.destroy();
	},
	// Extras for direct script use, not part of the hosted daemon runtime contract.
	ydoc,
};

export default defineConfig({
	daemon: {
		routes: [{ route: 'demo', start: () => demo }],
	},
});
