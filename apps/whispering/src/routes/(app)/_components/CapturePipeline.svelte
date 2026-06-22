<script lang="ts">
	import {
		TranscriptionSelector,
		TransformationSelector,
	} from '$lib/components/settings';
	import ManualDeviceSelector from '$lib/components/settings/selectors/ManualDeviceSelector.svelte';
	import VadDeviceSelector from '$lib/components/settings/selectors/VadDeviceSelector.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { viewTransition } from '$lib/utils/viewTransitions';
	import CaptureBehaviorPopover from './CaptureBehaviorPopover.svelte';

	let { surface }: { surface: 'manual' | 'vad' | 'import' } = $props();

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
	The capture controls for a surface. Manual and VAD differ only by their device
	selector (each backed by a different recorder config); import has no live device
	or capture behavior, so it shows just the model and transformation. The model is
	the one setting people hunt for, so its selector stretches as a labeled pill
	between the icon bookends; the rest stay compact icons with hover-tooltip labels.
-->
<div
	class="flex w-full items-center gap-1.5"
	role="group"
	aria-label="Capture pipeline"
>
	{#if surface === 'manual'}
		<ManualDeviceSelector
			iconViewTransitionName={viewTransition.pipeline.device}
		/>
	{:else if surface === 'vad'}
		<VadDeviceSelector iconViewTransitionName={viewTransition.pipeline.device} />
	{/if}
	<TranscriptionSelector
		variant="pipeline"
		iconViewTransitionName={viewTransition.pipeline.transcription}
	/>
	<TransformationSelector
		iconViewTransitionName={transformationViewTransitionName}
	/>
	{#if surface !== 'import'}
		<CaptureBehaviorPopover />
	{/if}
</div>
