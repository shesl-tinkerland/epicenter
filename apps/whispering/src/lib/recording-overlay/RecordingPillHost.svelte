<script lang="ts">
	import { tauri } from '#platform/tauri';
	import { dispatchPillAction } from '$lib/recording-overlay/pill-actions';
	import RecordingPill from '$lib/recording-overlay/RecordingPill.svelte';
	import { projectLifecycleToStatus } from '$lib/recording-overlay/projection';
	import { webPillLevel } from '$lib/recording-overlay/web-pill.svelte';
	import { dictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';

	// The web mount of the shared dictation pill. On desktop the pill is a native
	// overlay window, so this host renders nothing there; on web it places the
	// same `RecordingPill` as a fixed bottom-center element and drives it straight
	// from the lifecycle value, routing gestures through `pill-actions` (no IPC).
	// The pill body has no reveal action on web: the app window is already in
	// front, and a failure is surfaced by the notification and the recordings row.
	const status = $derived(projectLifecycleToStatus(dictationLifecycle.current));
</script>

{#if !tauri && status}
	<div class="pill-host">
		<RecordingPill
			{status}
			level={webPillLevel.level}
			onStop={() => dispatchPillAction('stop')}
			onCancel={() => dispatchPillAction('cancel')}
		/>
	</div>
{/if}

<style>
	/* Bottom-center, matching the desktop overlay's resting position
	   (OVERLAY_BOTTOM_MARGIN). Above page content, below modals and toasts. */
	.pill-host {
		position: fixed;
		bottom: 72px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 50;
	}
</style>
