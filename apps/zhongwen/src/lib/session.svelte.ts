import { requireSignedIn } from '@epicenter/auth';
import { createSession, type InferSignedIn } from '@epicenter/svelte';
import { openZhongwen } from '../routes/(signed-in)/zhongwen/browser';
import { auth } from './auth';

export const session = createSession({
	auth,
	build: (identity) => {
		const userId = identity.user.id;
		const zhongwen = openZhongwen({
			userId,
			encryptionKeys: () => requireSignedIn(auth).encryptionKeys,
		});
		return {
			userId,
			zhongwen,
			[Symbol.dispose]() {
				zhongwen[Symbol.dispose]();
			},
		};
	},
});

export type ZhongwenSignedIn = InferSignedIn<typeof session>;

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
 * // then use signedIn.zhongwen.X, etc.
 * ```
 *
 * Do NOT inline the call into templates: that re-evaluates the helper on
 * every reactive update and interacts badly with teardown. Bind once matches
 * the codebase rule for reactive accessors (memory:
 * feedback_no_destructure_reactive.md).
 */
export function getSignedInSession(): ZhongwenSignedIn {
	const c = session.current;
	if (c.status !== 'signed-in') {
		throw new Error(
			'[zhongwen] getSignedInSession() called outside the signed-in branch. ' +
				'This indicates a route or component mounted without the layout gate, ' +
				'or a callback firing after the workspace was disposed.',
		);
	}
	return c.signedIn;
}
