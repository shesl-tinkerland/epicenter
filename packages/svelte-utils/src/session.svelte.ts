/**
 * Shared session state machine for apps that gate UI on a signed-in identity
 * plus an app-defined payload (typically a workspace handle).
 *
 * Owns the auth subscription, transition writes, and the live-user-switch
 * refusal. Apps configure two hooks: `build` constructs the signed-in payload
 * from an identity; `applyKeys` applies rotated encryption keys in place.
 *
 * @example
 * ```ts
 * type FujiSignedIn = SignedInBase & { fuji: Fuji };
 * export const session = createSession<FujiSignedIn>({
 *   auth,
 *   build: (identity) => buildFujiSignedIn(identity),
 *   applyKeys: (s, i) => s.fuji.encryption.applyKeys(i.encryptionKeys),
 * });
 * ```
 */

import type { AuthClient, AuthIdentity, AuthState } from '@epicenter/auth';

export type Session<TSignedIn> =
	| { status: 'loading' }
	| { status: 'signed-out' }
	| { status: 'signed-in'; signedIn: TSignedIn };

export type SignedInBase = {
	readonly identity: AuthIdentity;
} & Disposable;

export function createSession<TSignedIn extends SignedInBase>({
	auth,
	build,
	applyKeys,
}: {
	auth: AuthClient;
	build: (identity: AuthIdentity) => TSignedIn;
	applyKeys: (signedIn: TSignedIn, identity: AuthIdentity) => void;
}) {
	const cell = $state<{ current: Session<TSignedIn> }>({
		current: { status: 'loading' },
	});

	function next(
		prev: Session<TSignedIn>,
		a: AuthState,
	): Session<TSignedIn> {
		if (a.status === 'pending') {
			return prev.status === 'loading' ? prev : { status: 'loading' };
		}
		if (a.status === 'signed-out') {
			if (prev.status === 'signed-in') prev.signedIn[Symbol.dispose]();
			return { status: 'signed-out' };
		}
		if (prev.status === 'signed-in') {
			if (prev.signedIn.identity.user.id === a.identity.user.id) {
				applyKeys(prev.signedIn, a.identity);
				return {
					status: 'signed-in',
					signedIn: { ...prev.signedIn, identity: a.identity },
				};
			}
			prev.signedIn[Symbol.dispose]();
			location.reload();
			throw new Error('unreachable: reload pending');
		}
		return { status: 'signed-in', signedIn: build(a.identity) };
	}

	const unsubscribe = auth.onStateChange((s) => {
		cell.current = next(cell.current, s);
	});
	// Initial replay: auth may have already settled before subscribe ran.
	cell.current = next(cell.current, auth.state);

	return {
		get current() {
			return cell.current;
		},
		[Symbol.dispose]() {
			unsubscribe();
			if (cell.current.status === 'signed-in') {
				cell.current.signedIn[Symbol.dispose]();
			}
		},
	};
}
