<script lang="ts">
	import { AuthForm } from '@epicenter/svelte/auth-form';
	import { WorkspaceGate } from '@epicenter/svelte/workspace-gate';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Loading } from '@epicenter/ui/loading';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { SvelteQueryDevtools } from '@tanstack/svelte-query-devtools';
	import { ModeWatcher } from 'mode-watcher';
	import { auth } from '$lib/auth';
	import { queryClient } from '$lib/query/client';
	import { session } from '$lib/session.svelte';
	import '@epicenter/ui/app.css';

	let { children } = $props();

	const current = $derived(session.current);
</script>

<svelte:head><title>Honeycrisp</title></svelte:head>

<QueryClientProvider client={queryClient}>
	{#if current.status === 'pending'}
		<Loading class="h-dvh" />
	{:else if current.status === 'signed-out'}
		<div class="flex h-dvh items-center justify-center">
			<AuthForm
				{auth}
				syncNoun="notes"
				onSocialSignIn={() =>
					auth.signInWithSocialRedirect({
						provider: 'google',
						callbackURL: window.location.origin,
					})}
			/>
		</div>
	{:else}
		<WorkspaceGate
			pending={current.signedIn.honeycrisp.idb.whenLoaded}
			onSignOut={() => auth.signOut()}
		>
			<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>
		</WorkspaceGate>
	{/if}
</QueryClientProvider>

<Toaster offset={16} closeButton />
<ConfirmationDialog />
<ModeWatcher defaultMode="dark" track={false} />
<SvelteQueryDevtools client={queryClient} buttonPosition="bottom-right" />
