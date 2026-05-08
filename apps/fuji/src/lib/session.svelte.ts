import { requireSignedIn } from '@epicenter/auth';
import {
	createSession,
	fromTable,
	type InferSignedIn,
} from '@epicenter/svelte';
import { getOrCreateInstallationId } from '@epicenter/workspace';
import { openFuji } from '../routes/(signed-in)/fuji/browser';
import type { EntryId } from '../routes/(signed-in)/fuji/workspace';
import { auth } from './auth';

export const session = createSession({
	auth,
	build: (identity) => {
		const userId = identity.user.id;
		const fuji = openFuji({
			userId,
			peer: {
				id: getOrCreateInstallationId(localStorage),
				name: 'Fuji',
				platform: 'web',
			},
			bearerToken: () => auth.bearerToken,
			encryptionKeys: () => requireSignedIn(auth).encryptionKeys,
		});
		const entriesMap = fromTable(fuji.tables.entries);
		const active = $derived(
			[...entriesMap.values()].filter((e) => e.deletedAt === undefined),
		);
		const deleted = $derived(
			[...entriesMap.values()].filter((e) => e.deletedAt !== undefined),
		);
		return {
			userId,
			fuji,
			entries: {
				get: (id: EntryId) => entriesMap.get(id),
				get active() {
					return active;
				},
				get deleted() {
					return deleted;
				},
			},
			[Symbol.dispose]() {
				entriesMap[Symbol.dispose]();
				fuji[Symbol.dispose]();
			},
		};
	},
});

export type FujiSignedIn = InferSignedIn<typeof session>;

if (import.meta.hot) {
	import.meta.hot.dispose(() => session[Symbol.dispose]());
}

/**
 * Returns the live signed-in session for this app.
 *
 * Throws if invoked outside the signed-in branch. The typical caller is a
 * `+page.svelte` mounted under the layout's `{#if status === 'signed-in'}`
 * gate; the layout has already proven the precondition by the time the page
 * mounts. If a route or component slips past that gate, or a callback fires
 * after the workspace was disposed, the throw surfaces the misuse loudly.
 *
 * Bind once at script init and dot-access fields:
 *
 * ```ts
 * const signedIn = getSignedInSession();
 * // then use signedIn.fuji.X, signedIn.entries.active, etc.
 * ```
 *
 * Do NOT inline the call into templates (`{#each getSignedInSession().entries.active}`):
 * that re-evaluates the helper on every reactive update and interacts badly
 * with teardown. Bind once matches the codebase rule for reactive accessors
 * (memory: feedback_no_destructure_reactive.md).
 */
export function getSignedInSession(): FujiSignedIn {
	const c = session.current;
	if (c.status !== 'signed-in') {
		throw new Error(
			'[fuji] getSignedInSession() called outside the signed-in branch. ' +
				'This indicates a route or component mounted without the layout gate, ' +
				'or a callback firing after the workspace was disposed.',
		);
	}
	return c.signedIn;
}
