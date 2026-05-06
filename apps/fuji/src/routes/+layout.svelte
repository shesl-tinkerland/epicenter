<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import { ModeWatcher } from 'mode-watcher';
	import { PageSpinner } from '@epicenter/svelte/page-spinner';
	import { auth } from '$lib/auth';
	import '@epicenter/ui/app.css';

	let { children } = $props();
</script>

<svelte:head><title>Fuji</title></svelte:head>

{#if auth.state.status === 'pending'}
	<PageSpinner />
{:else}
	{@render children?.()}
{/if}

<Toaster offset={16} closeButton />
<ConfirmationDialog />
<ModeWatcher defaultMode="dark" track={false} />
