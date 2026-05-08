<script lang="ts">
	import { AuthForm } from '@epicenter/svelte/auth-form';
	import { WorkspaceGate } from '@epicenter/svelte/workspace-gate';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Loading } from '@epicenter/ui/loading';
	import { Toaster } from '@epicenter/ui/sonner';
	import { ModeWatcher } from 'mode-watcher';
	import { auth } from '$lib/auth';
	import { session } from '$lib/session.svelte';
	import FujiAppShell from './(signed-in)/components/FujiAppShell.svelte';
	import '@epicenter/ui/app.css';

	let { children } = $props();

	const current = $derived(session.current);
</script>

<svelte:head><title>Fuji</title></svelte:head>

{#if current.status === 'pending'}
	<Loading class="h-dvh" />
{:else if current.status === 'signed-out'}
	<div class="flex h-dvh items-center justify-center">
		<AuthForm
			{auth}
			syncNoun="entries"
			onSocialSignIn={() =>
				auth.signInWithSocialRedirect({
					provider: 'google',
					callbackURL: window.location.origin,
				})}
		/>
	</div>
{:else}
	<WorkspaceGate
		pending={current.signedIn.fuji.idb.whenLoaded}
		forgetDevice={() => current.signedIn.fuji.wipe()}
		signOut={() => auth.signOut()}
	>
		<FujiAppShell>{@render children?.()}</FujiAppShell>
	</WorkspaceGate>
{/if}

<Toaster offset={16} closeButton />
<ConfirmationDialog />
<ModeWatcher defaultMode="dark" track={false} />
