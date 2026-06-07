<script lang="ts">
	import type { PageData } from './$types';
	import VaultView from './VaultView.svelte';

	let { data }: { data: PageData } = $props();
</script>

<!-- SvelteKit reuses this component across `[id]` changes, so key the live vault on its
     path: a new key tears down the old VaultView (its watcher disposes) and mounts a
     fresh one for the new folder. -->
{#key data.path}
	<VaultView path={data.path} />
{/key}
