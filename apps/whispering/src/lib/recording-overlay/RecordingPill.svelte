<script lang="ts">
	import AudioLinesIcon from '@lucide/svelte/icons/audio-lines';
	import CheckIcon from '@lucide/svelte/icons/check';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import MicIcon from '@lucide/svelte/icons/mic';
	import SquareIcon from '@lucide/svelte/icons/square';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import XIcon from '@lucide/svelte/icons/x';
	import type { DeliveryReach } from '$lib/operations/delivery';
	import {
		FAILURE_LABEL,
		type RecordingOverlayStatus,
	} from '$lib/recording-overlay/events';

	// The floating dictation pill, presentational and platform-free. It renders
	// whatever status it is handed and reports control gestures through callback
	// props; it never reads recorder state or touches Tauri. The Tauri build
	// drives it over IPC from a dedicated overlay webview; the web build mounts it
	// directly in the app layout. Both feed the same `status` and `level`.
	let {
		status,
		level,
		onStop,
		onCancel,
		onReveal,
	}: {
		/** What to display, or `null` when the dictation is idle (hidden). */
		status: RecordingOverlayStatus | null;
		/** Live, smoothed mic loudness, 0 (silent) to 1 (loud). */
		level: number;
		/** Stop the live capture (stop recording / stop listening). */
		onStop: () => void;
		/** Discard the live manual recording. */
		onCancel: () => void;
		/** Reveal Whispering by raising the main window (desktop). Omitted on web,
		 * where the app window is already in front. */
		onReveal?: () => void;
	} = $props();

	const isManual = $derived(
		status?.phase === 'recording' && status.trigger === 'manual',
	);
	const isSpeaking = $derived(
		status?.phase === 'recording' &&
			status.trigger === 'vad' &&
			status.vadState === 'SPEECH_DETECTED',
	);
	// The secondary pip riding beside a live VAD meter, or undefined when none
	// rides (manual recording, or a VAD session at rest).
	const vadPip = $derived(
		status?.phase === 'recording' && status.trigger === 'vad'
			? status.pip
			: undefined,
	);

	// Every non-recording phase is a "chip": one icon plus a short, fixed label,
	// with a tone that tints the icon (and, when failed, the whole pill). They
	// render through one block below instead of a branch apiece. The label is
	// always a closed, glanceable token, never a raw error message, so it fits the
	// fixed-width pill without truncation; the full failure detail lives in the OS
	// notification and the recordings row (ADR-0039).
	type ChipTone = 'neutral' | 'success' | 'degraded' | 'failed';
	type Chip = {
		Icon: typeof CheckIcon;
		label: string;
		tone: ChipTone;
		spin?: boolean;
	};

	// A delivery is a success at both reaches: a clean `output` reads green; the
	// `clipboard` fallback reads amber, "landed, but not where you asked".
	const DELIVERED_CHIP = {
		output: { Icon: CheckIcon, label: 'Delivered', tone: 'success' },
		clipboard: {
			Icon: CheckIcon,
			label: 'Copied to clipboard',
			tone: 'degraded',
		},
	} as const satisfies Record<DeliveryReach, Chip>;

	const chip = $derived.by((): Chip | null => {
		if (!status || status.phase === 'recording') return null;
		switch (status.phase) {
			case 'transcribing':
				return {
					Icon: LoaderCircleIcon,
					label: 'Transcribing',
					tone: 'neutral',
					spin: true,
				};
			case 'delivered':
				return DELIVERED_CHIP[status.reach];
			case 'failed':
				return {
					Icon: TriangleAlertIcon,
					label: FAILURE_LABEL[status.tier],
					tone: 'failed',
				};
		}
	});

	// Per-bar height envelope (taller in the middle) scaled by `level`. Reacting
	// the same amplitude through a fixed shape reads as a meter, not a flat block.
	const BAR_ENVELOPE = [0.5, 0.72, 0.9, 1, 0.9, 0.72, 0.5];
	const MIN_BAR_PX = 3;
	const MAX_BAR_PX = 18;

	function barHeight(envelope: number): number {
		return MIN_BAR_PX + envelope * level * (MAX_BAR_PX - MIN_BAR_PX);
	}

	function handleStop(event: MouseEvent) {
		// Don't let a button click bubble to the pill's focus-main handler:
		// stop/cancel should only stop/cancel, never reveal the main window.
		event.stopPropagation();
		onStop();
	}

	function handleCancel(event: MouseEvent) {
		event.stopPropagation();
		onCancel();
	}
</script>

<!-- The pill is non-focusable on desktop (an overlay window) and decorative on
     web, so it can never receive keyboard focus; clicking its body (not a
     button) just brings the main window forward. Keyboard handlers are moot
     here, hence the a11y ignores. -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
{#if status}
	<div
		class="overlay"
		class:speaking={isSpeaking}
		class:failed={chip?.tone === 'failed'}
		class:revealable={Boolean(onReveal)}
		title={onReveal ? 'Open Whispering' : undefined}
		onclick={onReveal}
	>
		{#if status.phase === 'recording'}
			<div class="icon">
				{#if isManual}
					<MicIcon class="size-4" />
				{:else}
					<AudioLinesIcon class="size-4" />
				{/if}
			</div>

			<div class="bars" aria-hidden="true">
				{#each BAR_ENVELOPE as envelope, i (i)}
					<span class="bar" style="height: {barHeight(envelope)}px"></span>
				{/each}
			</div>

			{#if !isManual}
				<!-- The VAD pip holds a fixed-width slot for the whole session, full or
				     empty, so the pill does not resize when the previous phrase's
				     spinner appears or clears. Empty at rest. -->
				<div
					class="pip"
					title={vadPip === 'transcribing'
						? 'Transcribing previous phrase'
						: undefined}
				>
					{#if vadPip === 'transcribing'}
						<LoaderCircleIcon class="size-3.5 animate-spin" />
					{/if}
				</div>
			{/if}

			<div class="actions">
				<button
					type="button"
					class="action stop"
					aria-label={isManual ? 'Stop recording' : 'Stop listening'}
					title={isManual ? 'Stop recording' : 'Stop listening'}
					onclick={handleStop}
				>
					<SquareIcon class="size-3.5" />
				</button>
				{#if isManual}
					<button
						type="button"
						class="action cancel"
						aria-label="Cancel recording"
						title="Cancel recording"
						onclick={handleCancel}
					>
						<XIcon class="size-4" />
					</button>
				{/if}
			</div>
		{:else if chip}
			<!-- One chip block for every non-recording phase. A failure is glanceable
			     by design: the terse label, no action; detail and retry live on the
			     recordings row (ADR-0039). -->
			{@const Icon = chip.Icon}
			<div
				class="icon"
				class:tone-success={chip.tone === 'success'}
				class:tone-degraded={chip.tone === 'degraded'}
				class:tone-failed={chip.tone === 'failed'}
			>
				<Icon class="size-4 {chip.spin ? 'animate-spin' : ''}" />
			</div>
			<span class="label">{chip.label}</span>
		{/if}
	</div>
{/if}

<style>
	.overlay {
		display: flex;
		align-items: center;
		gap: 8px;
		/* The pill hugs its content and is centered within its mount (the desktop
		   overlay window centers it; the web host translates it to center), so each
		   state is a snug chip with no dead space to leave the meter looking
		   off-center. The mount centers a fixed 40px-tall, up-to-184px-wide pill;
		   `max-width` caps it to that window so a long failed reason ellipsizes
		   rather than overflowing. */
		width: fit-content;
		max-width: 184px;
		height: 40px;
		padding: 0 10px;
		box-sizing: border-box;
		border-radius: 9999px;
		background: rgba(15, 15, 17, 0.82);
		border: 1px solid rgba(255, 255, 255, 0.08);
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
		color: rgba(255, 255, 255, 0.92);
		-webkit-backdrop-filter: blur(12px);
		backdrop-filter: blur(12px);
		user-select: none;
		-webkit-user-select: none;
	}

	/* The body is clickable only where it can reveal the main window: desktop,
	   where `onReveal` is wired. On web the app window is already in front, so
	   `onReveal` is omitted and the body shows no pointer or tooltip (the action
	   buttons stop propagation so only the empty areas would have triggered it). */
	.overlay.revealable {
		cursor: pointer;
	}

	/* Failed: a red chip so the failure reads at a glance, with the terse reason
	   in the label. No action: detail and retry live on the recordings row. */
	.overlay.failed {
		background: rgba(60, 18, 22, 0.92);
		border-color: rgba(239, 68, 68, 0.55);
	}

	.icon {
		display: flex;
		align-items: center;
		color: rgba(255, 255, 255, 0.85);
	}

	/* A clean delivery: green. */
	.icon.tone-success {
		color: #7ee2a8;
	}

	/* A reduced reach (clipboard/history): amber, so the glance reads "landed, but
	   not where you asked" rather than a clean success. */
	.icon.tone-degraded {
		color: #f5c97b;
	}

	/* A failure: red, paired with the red pill background below. */
	.icon.tone-failed {
		color: #ffb4b4;
	}

	/* The label takes only its text's width in the snug chip. Labels are closed,
	   short tokens that fit the fixed-width pill; the ellipsis is a safety net, not
	   a load-bearing truncation. The full failure detail lives in the OS
	   notification and the recordings row, never here. */
	.label {
		flex: 1;
		min-width: 0;
		font-size: 13px;
		font-weight: 500;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.bars {
		display: flex;
		align-items: center;
		gap: 3px;
		height: 20px;
	}

	.bar {
		width: 3px;
		border-radius: 9999px;
		background: rgba(255, 255, 255, 0.85);
		/* Height is set inline from the live mic level; the transition glides
		   between samples (~20-30 Hz) so the meter looks continuous. */
		transition: height 80ms linear;
	}

	/* Speech detected (VAD): tint the meter so the user sees it cross the
	   threshold, on top of the height already reacting to loudness. */
	.overlay.speaking .bar {
		background: #ffe5ee;
	}

	/* The VAD pip: the previous utterance's transcribe spinner riding beside the
	   live meter. Dimmed so it reads as secondary to the meter. No success or
	   failure state: success is the landing text, failure goes to the notification
	   and the recordings row. */
	.pip {
		/* A fixed-width slot (the size-3.5 icon's width) reserved for the whole VAD
		   session, so the pill keeps a steady width as the pip toggles. */
		flex: none;
		width: 14px;
		display: flex;
		align-items: center;
		justify-content: center;
		color: rgba(255, 255, 255, 0.5);
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	/* Resting state is a filled chip, not a bare icon, so the controls read as
	   buttons at a glance in the small pill. */
	.action {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border: none;
		border-radius: 9999px;
		background: rgba(255, 255, 255, 0.1);
		color: rgba(255, 255, 255, 0.92);
		cursor: pointer;
		transition:
			background-color 150ms ease-out,
			color 150ms ease-out,
			transform 100ms ease-out;
	}

	.action:hover {
		transform: scale(1.08);
	}

	.action:active {
		transform: scale(0.95);
	}

	/* Stop is the primary action: a red chip so it reads as "stop recording". */
	.action.stop {
		background: rgba(239, 68, 68, 0.28);
		color: #fff;
	}

	.action.stop:hover {
		background: rgba(239, 68, 68, 0.5);
	}

	.action.cancel:hover {
		background: rgba(250, 162, 202, 0.22);
		color: #ffd2e4;
	}

	@media (prefers-reduced-motion: reduce) {
		.bar {
			transition: none;
		}
	}
</style>
