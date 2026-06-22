<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { goto } from '$app/navigation';
	import { auth } from '$platform/auth';

	let signingIn = $state(false);
	let signInError = $state<string | null>(null);

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
			<p>Sign in to start chatting</p>
			{#if signInError}
				<p class="text-sm text-destructive">{signInError}</p>
			{/if}
			<Button onclick={startSignIn} disabled={signingIn}>
				{#if signingIn}
					<LoaderCircle class="size-4 animate-spin" />
					Signing in…
				{:else if auth.state.status === 'reauth-required'}
					Reconnect
				{:else}
					Sign in with Epicenter
				{/if}
			</Button>
		</div>
	</div>
</main>
