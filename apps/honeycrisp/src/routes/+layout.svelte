<script lang="ts">
	import { AuthForm } from '@epicenter/svelte/auth-form';
	import { PersistenceGate } from '@epicenter/svelte/persistence-gate';
	import { SessionGate } from '@epicenter/svelte/session-gate';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
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
</script>

<svelte:head><title>Honeycrisp</title></svelte:head>

<QueryClientProvider client={queryClient}>
	<SessionGate {session}>
		{#snippet signedOut()}
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
		{/snippet}
		{#snippet signedIn(s)}
			<PersistenceGate
				{auth}
				whenReady={s.honeycrisp.idb.whenLoaded}
				wipe={() => s.honeycrisp.wipe()}
			>
				<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>
			</PersistenceGate>
		{/snippet}
	</SessionGate>
</QueryClientProvider>

<Toaster offset={16} closeButton />
<ConfirmationDialog />
<ModeWatcher defaultMode="dark" track={false} />
<SvelteQueryDevtools client={queryClient} buttonPosition="bottom-right" />
