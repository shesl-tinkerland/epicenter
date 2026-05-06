<script lang="ts">
	import { goto } from '$app/navigation';
	import { auth } from '$lib/auth';
	import FujiAppShell from './components/FujiAppShell.svelte';
	import SignedIn from './components/SignedIn.svelte';

	let { children } = $props();

	$effect(() => {
		if (auth.state.status === 'signed-out') {
			goto('/sign-in', { replaceState: true });
		}
	});
</script>

{#if auth.state.status === 'signed-in'}
	{#key auth.state.identity.user.id}
		<SignedIn>
			<FujiAppShell>{@render children?.()}</FujiAppShell>
		</SignedIn>
	{/key}
{/if}
