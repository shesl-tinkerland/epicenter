<script lang="ts">
	import { secrets } from '$lib/state/secrets.svelte';

	let { children } = $props();
</script>

<!--
	The page content region, rendered inside whichever nav chrome the responsive
	branch picked. Pure view: it owns no app lifecycle, so the nav branch is free
	to remount it on a breakpoint change.

	The secret-vault boot gate (ADR 0041). The credential facade reads
	synchronously and reactively, but only once the vault has hydrated from
	IndexedDB. A page that reads a secret before then would see the un-hydrated
	default, which the facade flags loudly as a wiring bug. So hold the page
	content until `secrets.whenReady` resolves, the one-time gate the facade
	documents; every read after it is safe. Hydration is local and fast, so this
	is a brief hold, not a visible loading state.
-->
{#await secrets.whenReady then}
	<div class="flex flex-1 flex-col gap-2 min-w-0 w-full">
		{@render children()}
	</div>
{/await}
