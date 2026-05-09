<script lang="ts">
	import { AuthForm } from '@epicenter/svelte/auth-form';
	import { SessionGate } from '@epicenter/svelte/session-gate';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import { ModeWatcher } from 'mode-watcher';
	import { auth } from '$lib/auth-client';
	import { getGoogleCredentials } from '$lib/auth';
	import SidePanel from '$lib/components/SidePanel.svelte';
	import { session } from '$lib/tab-manager/session.svelte';
</script>

<SessionGate {session}>
	{#snippet signedOut()}
		<div class="flex h-dvh items-center justify-center p-4">
			<AuthForm
				{auth}
				syncNoun="tabs"
				onSocialSignIn={async () => {
					const { idToken, nonce } = await getGoogleCredentials();
					return auth.signInWithIdToken({
						provider: 'google',
						idToken,
						nonce,
					});
				}}
			/>
		</div>
	{/snippet}
	{#snippet signedIn(_s)}
		<SidePanel />
	{/snippet}
</SessionGate>

<Toaster position="bottom-center" richColors closeButton />
<ConfirmationDialog />
<ModeWatcher />
