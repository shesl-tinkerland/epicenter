<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Loading } from '@epicenter/ui/loading';
	import { Toaster } from '@epicenter/ui/sonner';
	import { WorkspaceGate } from '@epicenter/svelte/workspace-gate';
	import { ModeWatcher } from 'mode-watcher';
	import SignedInSessionProvider from '$lib/components/SignedInSessionProvider.svelte';
	import SignInPage from '$lib/components/SignInPage.svelte';
	import { auth } from '$lib/auth';
	import { session } from '$lib/session.svelte';
	import FujiAppShell from './(signed-in)/components/FujiAppShell.svelte';
	import '@epicenter/ui/app.css';

	let { children } = $props();

	const current = $derived(session.current);
</script>

<svelte:head><title>Fuji</title></svelte:head>

{#if current.status === 'loading'}
	<Loading class="h-dvh" />
{:else if current.status === 'signed-out'}
	<SignInPage />
{:else}
	<WorkspaceGate
		pending={current.signedIn.fuji.idb.whenLoaded}
		onSignOut={() => auth.signOut()}
	>
		<SignedInSessionProvider signedIn={current.signedIn}>
			<FujiAppShell>{@render children?.()}</FujiAppShell>
		</SignedInSessionProvider>
	</WorkspaceGate>
{/if}

<Toaster offset={16} closeButton />
<ConfirmationDialog />
<ModeWatcher defaultMode="dark" track={false} />
