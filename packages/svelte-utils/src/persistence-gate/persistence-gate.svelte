<!--
	Render gate that awaits a local persistence boot promise and offers
	recovery actions if it rejects. Pure dependency injection: callers pass
	the promise to await and the action to call on Forget Device. The gate
	knows nothing about workspace bundles, IDB, sessions, or auth state.

	Recovery actions in the error branch:
	  Reload          safe retry (always shown)
	  Forget device   confirms, calls `wipe()`, reloads (always shown)
	  Sign out        calls `auth.signOut()` and toasts on Result.error
	                  (only shown when `auth` is provided)

	Compose with `SessionGate` when you also need auth-state routing, or
	use standalone in flows that already have signed-in identity by the
	time the gate mounts.

	@example Standalone (no auth state machine):
	```svelte
	<PersistenceGate
		{auth}
		whenReady={opensidian.idb.whenLoaded}
		wipe={() => opensidian.wipe()}
	>
		{@render children?.()}
	</PersistenceGate>
	```

	@example Composed inside SessionGate:
	```svelte
	<SessionGate {session}>
		{#snippet signedOut()}<AuthForm {auth} ... />{/snippet}
		{#snippet signedIn(s)}
			<PersistenceGate
				{auth}
				whenReady={s.fuji.idb.whenLoaded}
				wipe={() => s.fuji.wipe()}
			>
				{@render children?.()}
			</PersistenceGate>
		{/snippet}
	</SessionGate>
	```
-->
<script lang="ts">
	import type { AuthClient } from '@epicenter/auth';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import type { Snippet } from 'svelte';
	import { extractErrorMessage } from 'wellcrafted/error';

	let {
		whenReady,
		wipe,
		auth,
		children,
		pending,
		error,
	}: {
		/** Promise the gate awaits before rendering children. */
		whenReady: Promise<unknown>;
		/**
		 * Action invoked after the user confirms "Forget this device". The gate
		 * reloads the page on success; rejecting throws a toast and re-enables
		 * the buttons. Pass the bundle's `wipe()` directly: `() => bundle.wipe()`.
		 */
		wipe: () => Promise<void>;
		/** Auth client. Optional. When provided, the error branch shows a Sign out button. */
		auth?: AuthClient;
		/** Rendered after `whenReady` resolves. */
		children: Snippet;
		/** Override for the loading branch. Defaults to `<Loading>`. */
		pending?: Snippet;
		/** Override for the error branch. Receives the rejection reason. */
		error?: Snippet<[unknown]>;
	} = $props();

	let forgettingDevice = $state(false);
	let signingOut = $state(false);

	function openForgetDeviceConfirmation() {
		confirmationDialog.open({
			title: 'Forget this device?',
			description:
				'This deletes local workspace data for this account on this device. Synced data stays in your account, but unsynced local changes may be lost.',
			confirm: { text: 'Forget device', variant: 'destructive' },
			onConfirm: async () => {
				forgettingDevice = true;
				try {
					await wipe();
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
		if (!auth) return;
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

{#await whenReady}
	{#if pending}{@render pending()}{:else}<Loading class="h-dvh" />{/if}
{:then _}
	{@render children()}
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
						onclick={openForgetDeviceConfirmation}
						disabled={forgettingDevice || signingOut}
					>
						Forget this device
					</Button>
					{#if auth}
						<Button
							variant="ghost"
							onclick={handleSignOut}
							disabled={forgettingDevice || signingOut}
						>
							Sign out
						</Button>
					{/if}
				</div>
			</Empty.Content>
		</Empty.Root>
	{/if}
{/await}
