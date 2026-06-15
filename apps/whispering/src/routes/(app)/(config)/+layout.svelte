<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { cn } from '@epicenter/ui/utils';
	import { commandCallbacks } from '$lib/commands';
	import {
		RecordingModeSelector,
		TranscriptionSelector,
		TransformationSelector,
	} from '$lib/components/settings';
	import ManualDeviceSelector from '$lib/components/settings/selectors/ManualDeviceSelector.svelte';
	import VadDeviceSelector from '$lib/components/settings/selectors/VadDeviceSelector.svelte';
	import {
		RECORDER_STATE_TO_ICON,
		VAD_STATE_TO_ICON,
	} from '$lib/constants/audio';
	import { manualRecorder } from '$lib/state/manual-recorder.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { vadRecorder } from '$lib/state/vad-recorder.svelte';
	import { viewTransition } from '$lib/utils/viewTransitions';

	let { children } = $props();
</script>

<header
	class={cn(
		'border-border/40 bg-background/95 supports-backdrop-filter:bg-background/60 z-30 border-b shadow-xs backdrop-blur-sm',
		'flex h-14 w-full items-center justify-between px-4 sm:px-8',
	)}
	style="view-transition-name: {viewTransition.global.header}"
>
	<Button tooltip="Go home" href="/" variant="ghost" class="-ml-4">
		<span class="text-lg font-bold">whispering</span>
	</Button>

	<div class="flex items-center gap-1.5">
		<div class="flex items-center gap-1.5">
			{#if settings.get('recording.mode') === 'manual'}
				{#if manualRecorder.state === 'RECORDING'}
					<Button
						tooltip="Cancel recording"
						onclick={() => commandCallbacks.cancelRecording()}
						variant="ghost"
						size="icon"
						style="view-transition-name: {viewTransition.global.cancel};"
					>
						🚫
					</Button>
				{:else}
					<ManualDeviceSelector />
					<TranscriptionSelector triggerVariant="standalone" />
					<TransformationSelector />
				{/if}
				{#if manualRecorder.state === 'RECORDING'}
					<Button
						tooltip="Stop recording"
						onclick={() => commandCallbacks.toggleManualRecording()}
						variant="ghost"
						size="icon"
						style="view-transition-name: {viewTransition.global.microphone}"
					>
						{RECORDER_STATE_TO_ICON[manualRecorder.state]}
					</Button>
				{:else}
					<div class="flex">
						<Button
							tooltip="Start recording"
							onclick={() => commandCallbacks.toggleManualRecording()}
							variant="ghost"
							size="icon"
							style="view-transition-name: {viewTransition.global.microphone}"
							class="rounded-r-none border-r-0"
						>
							{RECORDER_STATE_TO_ICON[manualRecorder.state]}
						</Button>
						<RecordingModeSelector class="rounded-l-none" />
					</div>
				{/if}
			{:else if settings.get('recording.mode') === 'vad'}
				{#if vadRecorder.state === 'IDLE'}
					<VadDeviceSelector />
					<TranscriptionSelector triggerVariant="standalone" />
					<TransformationSelector />
				{/if}
				{#if vadRecorder.state === 'IDLE'}
					<div class="flex">
						<Button
							tooltip="Start voice activated recording"
							onclick={() => commandCallbacks.toggleVadRecording()}
							variant="ghost"
							size="icon"
							style="view-transition-name: {viewTransition.global.microphone}"
							class="rounded-r-none border-r-0"
						>
							{VAD_STATE_TO_ICON[vadRecorder.state]}
						</Button>
						<RecordingModeSelector class="rounded-l-none" />
					</div>
				{:else}
					<Button
						tooltip="Stop voice activated recording"
						onclick={() => commandCallbacks.toggleVadRecording()}
						variant="ghost"
						size="icon"
						style="view-transition-name: {viewTransition.global.microphone}"
					>
						{VAD_STATE_TO_ICON[vadRecorder.state]}
					</Button>
				{/if}
			{:else if settings.get('recording.mode') === 'upload'}
				<TranscriptionSelector triggerVariant="standalone" />
				<TransformationSelector />
				<RecordingModeSelector />
			{/if}
		</div>
	</div>
</header>

<div class="flex-1 overflow-x-auto">{@render children()}</div>
