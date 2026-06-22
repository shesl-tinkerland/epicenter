<script lang="ts">
	import {
		TranscriptionSelector,
		TransformationSelector,
	} from '$lib/components/settings';
	import { settings } from '$lib/state/settings.svelte';
	import { viewTransition } from '$lib/utils/viewTransitions';
	import type { Snippet } from 'svelte';

	let { leading, trailing }: { leading?: Snippet; trailing?: Snippet } = $props();

	// The selected transformation's pipeline glyph morphs into that
	// transformation's row on /transformations, so name it with the same id the
	// row carries.
	const transformationViewTransitionName = $derived(
		viewTransition.transformation(
			settings.get('transformation.selectedId') ?? null,
		),
	);
</script>

<!--
	The capture controls row. The model and transformation are universal: every
	surface has them, and the model is the one setting people hunt for, so it
	stretches as a labeled pill between the bookends. `leading` (an input-device
	selector) and `trailing` (capture behavior) are the live-recording extras a host
	slots in; import uses the bare row.
-->
<div
	class="flex w-full items-center gap-1.5"
	role="group"
	aria-label="Capture pipeline"
>
	{@render leading?.()}
	<TranscriptionSelector
		variant="pipeline"
		iconViewTransitionName={viewTransition.pipeline.transcription}
	/>
	<TransformationSelector
		iconViewTransitionName={transformationViewTransitionName}
	/>
	{@render trailing?.()}
</div>
