<script lang="ts">
	import { WorkspaceGate } from '@epicenter/app-shell/workspace-gate';
	import { Button } from '@epicenter/ui/button';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { createMutation } from '@tanstack/svelte-query';
	import { mutationOptions } from 'wellcrafted/query';
	import { requireHoneycrisp, session } from '$lib/session';
	import { auth } from '$platform/auth';

	let { children } = $props();

	const startSignIn = createMutation(() =>
		mutationOptions({
			mutationKey: ['auth', 'startSignIn'],
			mutationFn: () => auth.startSignIn(),
		}),
	);
</script>

{#if session.current}
	<WorkspaceGate
		pending={session.current.idb.whenLoaded}
		onForgetDevice={() => requireHoneycrisp().wipe()}
		onSignOut={() => auth.signOut()}
	>
		<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>
	</WorkspaceGate>
{:else}
	<div
		class="flex h-dvh flex-col items-center justify-center gap-3 px-6 text-center"
	>
		<div class="space-y-1">
			<p class="text-sm font-medium">Sign in to Honeycrisp</p>
			<p class="text-xs text-muted-foreground">
				Sync your notes across devices.
			</p>
		</div>
		{#if startSignIn.error}
			<p class="text-xs text-destructive">{startSignIn.error.message}</p>
		{/if}
		<Button
			class="w-full max-w-xs"
			onclick={() => startSignIn.mutate()}
			disabled={startSignIn.isPending}
		>
			{#if startSignIn.isPending}
				<LoaderCircle class="size-4 animate-spin" />
				Signing in…
			{:else}
				Sign in with Epicenter
			{/if}
		</Button>
	</div>
{/if}
