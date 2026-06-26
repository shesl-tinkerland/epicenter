<script lang="ts">
	import { InstanceSettingsModal } from '@epicenter/app-shell/instance-setting';
	import { WorkspaceGate } from '@epicenter/app-shell/workspace-gate';
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import { auth } from '#platform/auth';
	import { instanceSetting } from '$lib/instance';
	import { requireFuji, session } from '$lib/session';
	import FujiAppShell from './components/FujiAppShell.svelte';

	let { children } = $props();

	let signingIn = $state(false);
	let signInError = $state<string | null>(null);
	let instanceModalOpen = $state(false);

	const instance = instanceSetting.readInstance();
	const usingToken = instance.token !== undefined;
	const instanceHost = new URL(instance.baseURL).host;
</script>

{#if session.current}
	<WorkspaceGate
		pending={session.current.idb.whenLoaded}
		onForgetDevice={() => requireFuji().wipe()}
		onSignOut={() => auth.signOut()}
	>
		<FujiAppShell>{@render children?.()}</FujiAppShell>
	</WorkspaceGate>
{:else}
	<div
		class="flex h-dvh flex-col items-center justify-center gap-3 px-6 text-center"
	>
		<div class="space-y-1">
			<p class="text-sm font-medium">
				{usingToken ? `Connect to ${instanceHost}` : 'Sign in to Fuji'}
			</p>
			<p class="text-xs text-muted-foreground">
				{usingToken
					? 'Sign in to your self-hosted instance.'
					: 'Sync your entries across devices.'}
			</p>
		</div>
		{#if signInError}
			<p class="text-xs text-destructive">{signInError}</p>
		{/if}
		<Button
			class="w-full max-w-xs"
			disabled={signingIn}
			onclick={async () => {
				signInError = null;
				signingIn = true;
				try {
					const { error } = await auth.startSignIn();
					if (error) signInError = error.message;
				} finally {
					signingIn = false;
				}
			}}
		>
			{#if signingIn}
				<Spinner class="size-4" />
				{usingToken ? 'Connecting…' : 'Signing in…'}
			{:else}
				{usingToken ? 'Retry connection' : 'Sign in with Epicenter'}
			{/if}
		</Button>
		<Button
			variant="link"
			size="sm"
			class="text-muted-foreground"
			onclick={() => (instanceModalOpen = true)}
		>
			{instanceSetting.isDefaultInstance(instance)
				? 'Connect to a self-hosted instance'
				: 'Change instance'}
		</Button>
	</div>
{/if}

<InstanceSettingsModal
	bind:open={instanceModalOpen}
	setting={instanceSetting}
	appName="Fuji"
/>
