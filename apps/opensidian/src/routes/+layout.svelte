<!--
	Opensidian is the outlier among the apps: `$lib/opensidian/client.ts`
	uses a top-level `await waitForAuthState` and exports `opensidian` as a
	singleton consumed by ~12 import sites. That model can't use SessionGate,
	which expects a reactive `session` built by `createSession`. Until the
	opensidian client is refactored onto createSession, this layout inlines
	the persistence-await and recovery UI directly. Same buttons, same copy
	as SessionGate; just no auth state machine because the singleton already
	guarantees signed-in.
-->
<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { toast, Toaster } from '@epicenter/ui/sonner';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { ModeWatcher } from 'mode-watcher';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { auth, opensidian } from '$lib/opensidian/client';
	import '../app.css';

	let { children } = $props();

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
					await opensidian.wipe();
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

<ConfirmationDialog />
<Toaster />
<ModeWatcher />

{#await opensidian.idb.whenLoaded}
	<Loading class="h-dvh" />
{:then _}
	{@render children()}
{:catch err}
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
{/await}
