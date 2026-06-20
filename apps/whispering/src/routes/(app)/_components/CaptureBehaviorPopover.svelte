<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Popover from '@epicenter/ui/popover';
	import SlidersHorizontalIcon from '@lucide/svelte/icons/sliders-horizontal';
	import OutputDeliveryControls from '$lib/components/OutputDeliveryControls.svelte';
	import { SettingSwitch } from '$lib/components/settings';
	import { captureSurface } from '$lib/state/capture-surface.svelte';

	// Quick access to the per-session capture behaviors that otherwise live in
	// Settings. The trailing bookend of the capture pipeline row, matching the
	// device/model/transformation popover grammar. Booleans only: pickers stay as
	// pills, set-and-forget config stays in Settings. This is the one surface that
	// curates a capture behavior (pause playback) next to the transcription output
	// delivery, and both reuse the same components the Settings page renders, so
	// there is one source of truth with no drift.
	let open = $state(false);

	// The pause window differs by mode (ADR-0027): manual holds the pause for the
	// whole recording, VAD pauses per utterance and resumes shortly after you stop
	// speaking. Word the description to match the surface on screen. Import shares
	// the recording phrasing: it never captures a live speaking window, and its
	// underlying durable trigger is the one that runs on the next capture.
	const pausePlaybackDescription = $derived.by(() => {
		switch (captureSurface.current) {
			case 'vad':
				return 'Pause music or video while you are speaking, then resume shortly after you stop.';
			case 'manual':
			case 'import':
				return 'Pause music or video while you are recording, then resume when you stop.';
		}
	});
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				tooltip="More options"
				aria-label="More options"
				aria-expanded={open}
				variant="ghost"
				size="icon"
			>
				<SlidersHorizontalIcon class="size-4" />
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-80">
		<div class="flex flex-col gap-3">
			<SettingSwitch
				key="recording.pausePlayback"
				label="Pause playback while recording"
				description={pausePlaybackDescription}
			/>
			<OutputDeliveryControls scope="transcription" />
		</div>
	</Popover.Content>
</Popover.Root>
