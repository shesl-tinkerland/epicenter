<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import { createResultMutation } from '@epicenter/svelte/query';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import UserMenu from '$lib/components/UserMenu.svelte';
	import { auth } from '$platform/auth';

	let { children } = $props();

	const startSignIn = createResultMutation(() => ({
		mutationFn: () => auth.startSignIn(),
	}));
</script>

{#if auth.state.status === 'signed-in'}
	<header class="border-b bg-background/95 backdrop-blur">
		<div class="mx-auto max-w-5xl px-6 flex items-center justify-between h-14">
			<span class="text-sm font-semibold tracking-tight">Epicenter</span>
			<UserMenu />
		</div>
	</header>
	<div class="mx-auto max-w-5xl px-6 py-12">{@render children()}</div>
{:else}
	<div class="flex min-h-screen items-center justify-center">
		<Card.Root class="w-full max-w-sm p-6">
			<div class="space-y-4 text-center">
				<div class="space-y-1">
					<p class="text-sm font-medium">Sign in to Epicenter</p>
					<p class="text-xs text-muted-foreground">
						Sign in to view billing and usage.
					</p>
				</div>
				{#if startSignIn.error}
					<p class="text-xs text-destructive">{startSignIn.error.message}</p>
				{/if}
				<Button
					class="w-full"
					onclick={() => startSignIn.mutate()}
					disabled={startSignIn.isPending}
				>
					{#if startSignIn.isPending}
						<LoaderCircle class="size-4 animate-spin" />
						Signing in…
					{:else if auth.state.status === 'reauth-required'}
						Reconnect
					{:else}
						Sign in with Epicenter
					{/if}
				</Button>
			</div>
		</Card.Root>
	</div>
{/if}
