<script lang="ts">
	import { InstanceSettingsModal } from '@epicenter/app-shell/instance-setting';
	import { WorkspaceGate } from '@epicenter/app-shell/workspace-gate';
	import { Button } from '@epicenter/ui/button';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { instanceSetting } from '$lib/instance';
	import { requireOpensidian, session } from '$lib/session';
	import { auth } from '$platform/auth';

	let { children } = $props();

	let signingIn = $state(false);
	let signInError = $state<string | null>(null);
	let instanceModalOpen = $state(false);

	const instance = instanceSetting.readInstance();
	const usingToken = instance.token !== undefined;
	const instanceHost = new URL(instance.baseURL).host;

	async function startSignIn() {
		signInError = null;
		signingIn = true;
		try {
			const { error } = await auth.startSignIn();
			if (error) signInError = error.message;
		} finally {
			signingIn = false;
		}
	}
</script>

{#if session.current}
	<WorkspaceGate
		pending={session.current.idb.whenLoaded}
		onForgetDevice={() => requireOpensidian().wipe()}
		onSignOut={() => auth.signOut()}
	>
		{@render children()}
	</WorkspaceGate>
{:else}
	<div
		class="flex h-dvh flex-col items-center justify-center gap-3 px-6 text-center"
	>
		<div class="space-y-1">
			<p class="text-sm font-medium">
				{usingToken ? `Connect to ${instanceHost}` : 'Sign in to Opensidian'}
			</p>
			<p class="text-xs text-muted-foreground">
				{usingToken
					? 'Sign in to your self-hosted instance.'
					: 'Sync your notes across devices.'}
			</p>
		</div>
		{#if signInError}
			<p class="text-xs text-destructive">{signInError}</p>
		{/if}
		<Button class="w-full max-w-xs" onclick={startSignIn} disabled={signingIn}>
			{#if signingIn}
				<LoaderCircle class="size-4 animate-spin" />
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
	appName="Opensidian"
/>
