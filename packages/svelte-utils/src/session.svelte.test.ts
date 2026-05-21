import { expect, test } from 'bun:test';
import type { AuthClient, AuthState, LocalIdentity } from '@epicenter/auth';
import { Ok } from 'wellcrafted/result';
import { createSession } from './session.svelte.js';

(globalThis as unknown as { $state: <T>(value: T) => T }).$state = (value) =>
	value;

const localIdentity = (subject: string): LocalIdentity => ({
	subject,
	keyring: [
		{
			version: 1,
			subjectKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
		},
	],
});

const signedIn = (subject: string): AuthState => ({
	status: 'signed-in',
	localIdentity: localIdentity(subject),
});

test('signed-out gap disposes old payload before building the next subject', () => {
	const { auth, setState } = createAuthHarness(signedIn('alice'));
	const events: string[] = [];

	const session = createSession({
		auth,
		build: () => {
			const subject =
				auth.state.status === 'signed-out'
					? 'signed-out'
					: auth.state.localIdentity.subject;
			events.push(`build:${subject}`);

			return {
				subject,
				[Symbol.dispose]() {
					events.push(`dispose:${subject}`);
				},
			};
		},
	});

	setState({ status: 'signed-out' });
	setState(signedIn('bob'));

	expect(events).toEqual(['build:alice', 'dispose:alice', 'build:bob']);
	expect(session.current?.subject).toBe('bob');

	session[Symbol.dispose]();
});

function createAuthHarness(initial: AuthState) {
	let state = initial;
	const listeners = new Set<(state: AuthState) => void>();
	const auth: AuthClient = {
		get state() {
			return state;
		},
		onStateChange(fn) {
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		},
		startSignIn: async () => Ok(undefined),
		signOut: async () => Ok(undefined),
		fetch: async () => new Response(null, { status: 204 }),
		openWebSocket: async () => {
			throw new Error('openWebSocket is not used by this test.');
		},
		[Symbol.dispose]() {
			listeners.clear();
		},
	};

	return {
		auth,
		setState(next: AuthState) {
			state = next;
			for (const listener of listeners) listener(next);
		},
	};
}
