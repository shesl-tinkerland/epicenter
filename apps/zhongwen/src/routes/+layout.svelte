<script lang="ts">
	import '../app.css';
	import { Loading } from '@epicenter/ui/loading';
	import { Toaster } from '@epicenter/ui/sonner';
	import { ModeWatcher } from 'mode-watcher';
	import { auth } from '$lib/auth';

	let { children } = $props();
</script>

<Toaster />
<ModeWatcher />
{#if auth.state.status === 'pending'}
	<Loading class="h-dvh" />
{:else}
	{@render children?.()}
{/if}
