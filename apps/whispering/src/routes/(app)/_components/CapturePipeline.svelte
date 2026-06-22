<script lang="ts">
	import type { Snippet } from 'svelte';
	import CaptureBehaviorPopover from './CaptureBehaviorPopover.svelte';
	import CapturePipelineCore from './CapturePipelineCore.svelte';

	// A live capture pipeline: the host hands in its input-device selector as
	// children (manual vs VAD is the only difference), and the pipeline adds the
	// universal model and transformation controls plus the capture-behavior popover.
	// The surface never has to name itself.
	let { children }: { children: Snippet } = $props();
</script>

<CapturePipelineCore leading={children}>
	{#snippet trailing()}
		<CaptureBehaviorPopover />
	{/snippet}
</CapturePipelineCore>
