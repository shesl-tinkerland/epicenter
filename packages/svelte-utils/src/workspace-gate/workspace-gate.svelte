<!--
	Render gate that blocks children until `pending` resolves.

	Composition: defaults the loading state to <Loading> (the same shell
	used by pre-auth layouts) so the moment children mount is the only
	visible transition. The error state defaults to a workspace-flavored
	Empty.Root with three actions:

	  Reload          safe retry
	  Forget device   local repair (calls `forgetDevice`, then reloads)
	  Sign out        secondary auth escape hatch (calls `signOut`)

	`pending` is typically `bundle.idb.whenLoaded`, which is a local
	persistence promise. Sign-out does not repair local persistence;
	`wipe()` plus reload does. The gate frames the actions to match.

	Both branches accept snippet overrides for apps that need different chrome.

	@example
	```svelte
	<script lang="ts">
		import { WorkspaceGate } from '@epicenter/svelte/workspace-gate';
		import { auth } from '$lib/auth';
		import { session } from '$lib/session.svelte';

		const current = $derived(session.current);
	</script>

	{#if current.status === 'signed-in'}
		<WorkspaceGate
			pending={current.signedIn.fuji.idb.whenLoaded}
			forgetDevice={() => current.signedIn.fuji.wipe()}
			signOut={() => auth.signOut()}
		>
			{@render children?.()}
		</WorkspaceGate>
	{/if}
	```
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import type { Snippet } from 'svelte';

	let {
		pending,
		children,
		loading,
		error,
		forgetDevice,
		signOut,
	}: {
		/** Promise the gate awaits before rendering children. */
		pending: Promise<unknown>;
		/** Children rendered after `pending` resolves. */
		children: Snippet;
		/** Override for the loading branch. Defaults to <Loading>. */
		loading?: Snippet;
		/** Override for the error branch. Receives the rejection reason. */
		error?: Snippet<[unknown]>;
		/**
		 * Local-repair primitive. The gate calls this after the user confirms
		 * the destructive "Forget this device" dialog, then reloads the page.
		 * Pass the bundle's `wipe()` method directly, e.g.
		 * `() => workspace.wipe()`. Return value is awaited and ignored.
		 * Omit to hide the button (e.g. on apps that have no auth scope).
		 */
		forgetDevice?: () => unknown;
		/**
		 * Auth-exit primitive. The gate calls this when the user clicks the
		 * secondary Sign out button. Post-sign-out behavior (page reload,
		 * navigation, teardown) is owned by the auth/session reactor, not
		 * by the gate. Return value is awaited and ignored.
		 * Omit to hide the button.
		 */
		signOut?: () => unknown;
	} = $props();

	let forgettingDevice = $state(false);
	let signingOut = $state(false);

	function openForgetDeviceConfirmation() {
		if (!forgetDevice) return;
		confirmationDialog.open({
			title: 'Forget this device?',
			description:
				'This deletes local workspace data for this account on this device. Synced data stays in your account, but unsynced local changes may be lost.',
			confirm: { text: 'Forget device', variant: 'destructive' },
			onConfirm: async () => {
				forgettingDevice = true;
				try {
					await forgetDevice();
					window.location.reload();
				} catch (err) {
					toast.error('Failed to forget this device', {
						description: err instanceof Error ? err.message : undefined,
					});
				} finally {
					forgettingDevice = false;
				}
			},
		});
	}

	async function handleSignOut() {
		if (!signOut) return;
		signingOut = true;
		try {
			await signOut();
		} finally {
			signingOut = false;
		}
	}
</script>

{#await pending}
	{#if loading}
		{@render loading()}
	{:else}
		<Loading class="h-dvh" />
	{/if}
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
					{#if forgetDevice}
						<Button
							variant="destructive"
							onclick={openForgetDeviceConfirmation}
							disabled={forgettingDevice || signingOut}
						>
							Forget this device
						</Button>
					{/if}
					{#if signOut}
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
