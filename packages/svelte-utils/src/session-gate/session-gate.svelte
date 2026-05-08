<!--
	Render gate that routes children based on the auth state machine projected
	by `createSession`. One job: pending / signed-out / signed-in switch.

	Does not own persistence loading, recovery UI, or auth.signOut() handling.
	Compose with `PersistenceGate` inside the `signedIn` snippet when the app
	also needs to gate on a local-persistence boot promise.

	@example
	```svelte
	<SessionGate {session}>
		{#snippet signedOut()}
			<AuthForm {auth} syncNoun="entries" onSocialSignIn={...} />
		{/snippet}
		{#snippet signedIn(s)}
			<PersistenceGate
				{auth}
				whenReady={s.fuji.idb.whenLoaded}
				wipe={() => s.fuji.wipe()}
			>
				<FujiAppShell>{@render children?.()}</FujiAppShell>
			</PersistenceGate>
		{/snippet}
	</SessionGate>
	```
-->
<script
	lang="ts"
	generics="TSignedIn extends { userId: string } & Disposable"
>
	import { Loading } from '@epicenter/ui/loading';
	import type { Snippet } from 'svelte';
	import type { Session } from '../session.svelte.js';

	let {
		session,
		signedIn,
		signedOut,
		pending,
	}: {
		/** Session created by `createSession({ auth, build })`. */
		session: { readonly current: Session<TSignedIn> };
		/** Renders when status is signed-in. Receives the typed signed-in payload. */
		signedIn: Snippet<[TSignedIn]>;
		/**
		 * Renders when status is signed-out. Required. The right shape varies by
		 * app (inline `<AuthForm>`, redirect to a sign-in route, marketing splash,
		 * etc.) and there is no honest default, so the gate refuses to guess.
		 */
		signedOut: Snippet;
		/** Override for the pending branch. Defaults to `<Loading>`. */
		pending?: Snippet;
	} = $props();

	const current = $derived(session.current);
</script>

{#if current.status === 'pending'}
	{#if pending}{@render pending()}{:else}<Loading class="h-dvh" />{/if}
{:else if current.status === 'signed-out'}
	{@render signedOut()}
{:else}
	{@render signedIn(current.signedIn)}
{/if}
