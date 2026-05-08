<script lang="ts">
	import { WorkspaceGate } from '@epicenter/svelte/workspace-gate';
	import { Loading } from '@epicenter/ui/loading';
	import { goto } from '$app/navigation';
	import { auth } from '$lib/auth';
	import { session } from '$lib/session.svelte';

	let { children } = $props();

	const current = $derived(session.current);

	$effect(() => {
		if (current.status === 'signed-out') {
			void goto('/sign-in', { replaceState: true });
		}
	});
</script>

{#if current.status === 'pending' || current.status === 'signed-out'}
	<Loading class="h-dvh" />
{:else}
	<WorkspaceGate
		pending={current.signedIn.zhongwen.idb.whenLoaded}
		forgetDevice={() => current.signedIn.zhongwen.wipe()}
		signOut={() => auth.signOut()}
	>
		{@render children?.()}
	</WorkspaceGate>
{/if}
