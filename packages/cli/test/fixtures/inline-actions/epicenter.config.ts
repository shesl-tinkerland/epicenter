/**
 * Minimal fixture — one workspace export with inline `defineQuery` /
 * `defineMutation` nodes under `actions`. No sqlite, sync, or encryption:
 * `LoadedWorkspace` only requires `whenReady` and `[Symbol.dispose]`, plus
 * `actions` for runnable commands.
 *
 * Used by `test/e2e-inline-actions.test.ts` to exercise dot-path resolution
 * end-to-end without depending on any attach primitive.
 */

import { defineMutation, defineQuery } from '@epicenter/sync';
import Type from 'typebox';
import * as Y from 'yjs';

const ydoc = new Y.Doc({ guid: 'epicenter.demo' });
const state = ydoc.getMap<number>('state');
state.set('count', 0);

const actions = {
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
};

export const demo = {
	whenReady: Promise.resolve(),
	actions,
	[Symbol.dispose]() {
		ydoc.destroy();
	},
	// extras (not part of LoadedWorkspace contract)
	ydoc,
};
