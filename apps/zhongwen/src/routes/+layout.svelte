<script lang="ts">
	import '../app.css';
	import { PageSpinner } from '@epicenter/svelte/page-spinner';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import { ModeWatcher } from 'mode-watcher';
	import { auth } from '$lib/auth';

	let { children } = $props();
</script>

<Toaster />
<ConfirmationDialog />
<ModeWatcher />
{#if auth.state.status === 'pending'}
	<PageSpinner />
{:else}
	{@render children?.()}
{/if}
