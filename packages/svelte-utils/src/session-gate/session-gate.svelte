<!--
	Render gate that owns the full auth + local-persistence boundary for an
	app whose signed-in payload was built by `createSession`.

	The gate replaces the previous split where `+layout.svelte` open-coded the
	pending / signed-out / signed-in switch and `WorkspaceGate` only covered
	`bundle.idb.whenLoaded`. Here, the auth state, the persistence await, the
	`auth.signOut()` Result handling, and the forget-device confirmation all
	live in one place. Apps render two snippets (signedOut and signedIn) and
	stop wiring callbacks.

	Status routing:

	1. `pending`     renders `<Loading>` (overridable via `pending` snippet)
	2. `signed-out`  renders `signedOut` snippet (or `<Loading>` if omitted,
	                 useful when the app redirects to a sign-in route)
	3. `signed-in`   awaits `payload.whenReady`, then renders `signedIn(payload)`.
	                 On rejection: shows recovery (Reload, Forget device which
	                 calls `payload.wipe()` then reloads, Sign out which calls
	                 `auth.signOut()` and surfaces its Result.error as a toast).

	The signed-in payload type carries `whenReady: Promise<unknown>` and
	`wipe: () => Promise<void>` as top-level fields. Apps build that shape
	inside `createSession({ build })` by delegating to the underlying workspace
	bundle:

	```ts
	return {
		userId,
		fuji,
		entries,
		whenReady: fuji.idb.whenLoaded,
		wipe: () => fuji.wipe(),
		[Symbol.dispose]() { ... },
	};
	```

	@example
	```svelte
	<script lang="ts">
		import { SessionGate } from '@epicenter/svelte/session-gate';
		import { AuthForm } from '@epicenter/svelte/auth-form';
		import { auth } from '$lib/auth';
		import { session } from '$lib/session.svelte';
	</script>

	<SessionGate {auth} {session}>
		{#snippet signedOut()}
			<AuthForm {auth} syncNoun="entries" onSocialSignIn={...} />
		{/snippet}
		{#snippet signedIn(s)}
			<FujiAppShell>{@render children?.()}</FujiAppShell>
		{/snippet}
	</SessionGate>
	```
-->
<script
	lang="ts"
	generics="TSignedIn extends { userId: string; whenReady: Promise<unknown>; wipe: () => Promise<void> } & Disposable"
>
	import type { AuthClient } from '@epicenter/auth';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import type { Snippet } from 'svelte';
	import { extractErrorMessage } from 'wellcrafted/error';
	import type { Session } from '../session.svelte.js';

	let {
		auth,
		session,
		signedIn,
		signedOut,
		pending,
		error,
	}: {
		/** Auth client. SessionGate calls `auth.signOut()` and turns its Result.error into a toast. */
		auth: AuthClient;
		/** Session created by `createSession({ auth, build })`. */
		session: { readonly current: Session<TSignedIn> };
		/** Renders when status is signed-in AND the payload's `whenReady` has resolved. */
		signedIn: Snippet<[TSignedIn]>;
		/**
		 * Renders when status is signed-out. Required. The right shape varies by
		 * app (inline `<AuthForm>`, redirect to a sign-in route, marketing splash,
		 * etc.) and there is no honest default, so the gate refuses to guess.
		 * Apps that redirect from a layout effect can pass `<Loading />` here for
		 * the brief transition window before navigation completes.
		 */
		signedOut: Snippet;
		/** Override for the loading branch (used during pending and during whenReady await). Defaults to `<Loading>`. */
		pending?: Snippet;
		/** Override for the load-failure branch. Receives the rejection reason. */
		error?: Snippet<[unknown]>;
	} = $props();

	const current = $derived(session.current);

	let forgettingDevice = $state(false);
	let signingOut = $state(false);

	function openForgetDeviceConfirmation(payload: TSignedIn) {
		confirmationDialog.open({
			title: 'Forget this device?',
			description:
				'This deletes local workspace data for this account on this device. Synced data stays in your account, but unsynced local changes may be lost.',
			confirm: { text: 'Forget device', variant: 'destructive' },
			onConfirm: async () => {
				forgettingDevice = true;
				try {
					await payload.wipe();
					window.location.reload();
				} catch (err) {
					toast.error('Failed to forget this device', {
						description: extractErrorMessage(err),
					});
				} finally {
					forgettingDevice = false;
				}
			},
		});
	}

	async function handleSignOut() {
		signingOut = true;
		try {
			const { error: signOutError } = await auth.signOut();
			if (signOutError) throw signOutError;
		} catch (err) {
			toast.error('Failed to sign out', {
				description: extractErrorMessage(err),
			});
		} finally {
			signingOut = false;
		}
	}
</script>

{#if current.status === 'pending'}
	{#if pending}{@render pending()}{:else}<Loading class="h-dvh" />{/if}
{:else if current.status === 'signed-out'}
	{@render signedOut()}
{:else}
	{@const s = current.signedIn}
	{#await s.whenReady}
		{#if pending}{@render pending()}{:else}<Loading class="h-dvh" />{/if}
	{:then _}
		{@render signedIn(s)}
	{:catch err}
		{#if error}
			{@render error(err)}
		{:else}
			<Empty.Root class="h-dvh flex-none border-0">
				<Empty.Media>
					<TriangleAlertIcon class="size-8 text-muted-foreground" />
				</Empty.Media>
				<Empty.Title>Failed to load workspace</Empty.Title>
				<Empty.Description>
					{err instanceof Error
						? err.message
						: 'The workspace could not be opened from local data on this device.'}
				</Empty.Description>
				<Empty.Content>
					<div class="flex items-center gap-2">
						<Button
							variant="outline"
							onclick={() => window.location.reload()}
							disabled={forgettingDevice || signingOut}
						>
							Reload
						</Button>
						<Button
							variant="destructive"
							onclick={() => openForgetDeviceConfirmation(s)}
							disabled={forgettingDevice || signingOut}
						>
							Forget this device
						</Button>
						<Button
							variant="ghost"
							onclick={handleSignOut}
							disabled={forgettingDevice || signingOut}
						>
							Sign out
						</Button>
					</div>
				</Empty.Content>
			</Empty.Root>
		{/if}
	{/await}
{/if}
