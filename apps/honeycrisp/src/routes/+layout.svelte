<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { SvelteQueryDevtools } from '@tanstack/svelte-query-devtools';
	import { ModeWatcher } from 'mode-watcher';
	import { PageSpinner } from '@epicenter/svelte/page-spinner';
	import { auth } from '$lib/auth';
	import { queryClient } from '$lib/query/client';
	import '@epicenter/ui/app.css';

	let { children } = $props();
</script>

<svelte:head><title>Honeycrisp</title></svelte:head>

<QueryClientProvider client={queryClient}>
	{#if auth.state.status === 'pending'}
		<PageSpinner />
	{:else}
		{@render children?.()}
	{/if}
</QueryClientProvider>

<Toaster offset={16} closeButton />
<ConfirmationDialog />
<ModeWatcher defaultMode="dark" track={false} />
<SvelteQueryDevtools client={queryClient} buttonPosition="bottom-right" />
