<script lang="ts">
	import { AuthForm } from '@epicenter/svelte/auth-form';
	import { SessionGate } from '@epicenter/svelte/session-gate';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import { ModeWatcher } from 'mode-watcher';
	import { auth } from '$lib/auth';
	import { session } from '$lib/session.svelte';
	import FujiAppShell from './(signed-in)/components/FujiAppShell.svelte';
	import '@epicenter/ui/app.css';

	let { children } = $props();
</script>

<svelte:head><title>Fuji</title></svelte:head>

<SessionGate {auth} {session}>
	{#snippet signedOut()}
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
	{/snippet}
	{#snippet signedIn(_s)}
		<FujiAppShell>{@render children?.()}</FujiAppShell>
	{/snippet}
</SessionGate>

<Toaster offset={16} closeButton />
<ConfirmationDialog />
<ModeWatcher defaultMode="dark" track={false} />
