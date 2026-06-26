<script lang="ts">
	import { InstanceSettingsModal } from '@epicenter/app-shell/instance-setting';
	import { Button } from '@epicenter/ui/button';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { goto } from '$app/navigation';
	import { instanceSetting } from '$lib/instance';
	import { auth } from '$platform/auth';

	let signingIn = $state(false);
	let signInError = $state<string | null>(null);
	let instanceModalOpen = $state(false);

	const instance = instanceSetting.readInstance();
	const usingToken = instance.token !== undefined;
	const instanceHost = new URL(instance.baseURL).host;

	$effect(() => {
		if (auth.state.status === 'signed-in') {
			void goto('/', { replaceState: true });
		}
	});

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

<main class="flex h-dvh flex-col">
	<header class="flex items-center justify-between border-b px-4 py-3">
		<h1 class="text-lg font-semibold">中文 Vocab</h1>
		<Button size="sm" onclick={startSignIn} disabled={signingIn}>
			{#if signingIn}
				<LoaderCircle class="size-4 animate-spin" />
			{/if}
			Sign In
		</Button>
	</header>

	<div class="flex flex-1 items-center justify-center">
		<div class="space-y-3 text-center text-muted-foreground">
			<p>
				{usingToken
					? `Connect to ${instanceHost}`
					: 'Sign in to start chatting'}
			</p>
			{#if signInError}
				<p class="text-sm text-destructive">{signInError}</p>
			{/if}
			<Button onclick={startSignIn} disabled={signingIn}>
				{#if signingIn}
					<LoaderCircle class="size-4 animate-spin" />
					{usingToken ? 'Connecting…' : 'Signing in…'}
				{:else if auth.state.status === 'reauth-required'}
					Reconnect
				{:else if usingToken}
					Retry connection
				{:else}
					Sign in with Epicenter
				{/if}
			</Button>
			<div>
				<Button
					variant="link"
					size="sm"
					onclick={() => (instanceModalOpen = true)}
				>
					{instanceSetting.isDefaultInstance(instance)
						? 'Connect to a self-hosted instance'
						: 'Change instance'}
				</Button>
			</div>
		</div>
	</div>
</main>

<InstanceSettingsModal
	bind:open={instanceModalOpen}
	setting={instanceSetting}
	appName="Vocab"
/>
