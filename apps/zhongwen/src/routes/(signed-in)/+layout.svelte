<script lang="ts">
	import { PersistenceGate } from '@epicenter/svelte/persistence-gate';
	import { SessionGate } from '@epicenter/svelte/session-gate';
	import { Loading } from '@epicenter/ui/loading';
	import { goto } from '$app/navigation';
	import { auth } from '$lib/auth';
	import { session } from '$lib/session.svelte';

	let { children } = $props();

	$effect(() => {
		if (session.current.status === 'signed-out') {
			void goto('/sign-in', { replaceState: true });
		}
	});
</script>

<SessionGate {session}>
	{#snippet signedOut()}
		<Loading class="h-dvh" />
	{/snippet}
	{#snippet signedIn(s)}
		<PersistenceGate
			{auth}
			whenReady={s.zhongwen.idb.whenLoaded}
			wipe={() => s.zhongwen.wipe()}
		>
			{@render children?.()}
		</PersistenceGate>
	{/snippet}
</SessionGate>
