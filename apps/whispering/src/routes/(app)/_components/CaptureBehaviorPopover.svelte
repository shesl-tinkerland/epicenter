<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Popover from '@epicenter/ui/popover';
	import SlidersHorizontalIcon from '@lucide/svelte/icons/sliders-horizontal';
	import { SettingSwitch } from '$lib/components/settings';

	// Quick access to the per-session capture behaviors that otherwise live in
	// Settings. The trailing bookend of the capture pipeline row, matching the
	// device/model/transformation popover grammar. Booleans only: pickers stay as
	// pills, set-and-forget config stays in Settings. Each switch reuses the same
	// SettingSwitch as the Settings page, so home and Settings write one source of
	// truth with no drift.
	let open = $state(false);
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
				description="Pause music or video while your voice is captured, then resume it."
			/>
			<SettingSwitch
				key="output.transcription.cursor"
				label="Paste at cursor"
				description="Paste the transcript where your cursor is, not just copy it to the clipboard."
			/>
		</div>
	</Popover.Content>
</Popover.Root>
