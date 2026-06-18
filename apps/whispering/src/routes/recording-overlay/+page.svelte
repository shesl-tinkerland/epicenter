<script lang="ts">
	import AudioLinesIcon from '@lucide/svelte/icons/audio-lines';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import MicIcon from '@lucide/svelte/icons/mic';
	import SquareIcon from '@lucide/svelte/icons/square';
	import XIcon from '@lucide/svelte/icons/x';
	import { type UnlistenFn } from '@tauri-apps/api/event';
	import { onDestroy, onMount } from 'svelte';
	import { revealMainWindow } from '$lib/main-window';
	import {
		type RecordingOverlayAction,
		recordingOverlayAction,
		recordingOverlayMicLevel,
		recordingOverlayReady,
		recordingOverlayStatus,
		type RecordingOverlayStatus,
	} from '$lib/recording-overlay/events';

	// The overlay lives in its own webview, so it cannot read the recorder
	// state modules directly. The main window pushes the current status over a
	// Tauri event and we render from that. `null` means nothing to show yet
	// (the window is hidden before the first status arrives).
	let status = $state<RecordingOverlayStatus | null>(null);

	const isManual = $derived(
		!!status && 'trigger' in status && status.trigger === 'manual',
	);
	const isPolishing = $derived(!!status && 'phase' in status);
	const isSpeaking = $derived(
		!!status && 'trigger' in status && status.state === 'SPEECH_DETECTED',
	);

	// Live, smoothed mic loudness, 0 (silent) to 1 (loud). Driven by the
	// `mic-level` event: VAD frames in JS for voice-activated capture, the Rust
	// CPAL worker for manual recording. Both send a raw RMS amplitude; we apply
	// the perceptual curve and smoothing here so the bars react to the actual
	// voice rather than looping on a timer.
	let level = $state(0);

	// Per-bar height envelope (taller in the middle) scaled by `level`. Reacting
	// the same amplitude through a fixed shape reads as a meter, not a flat block.
	const BAR_ENVELOPE = [0.5, 0.72, 0.9, 1, 0.9, 0.72, 0.5];
	const MIN_BAR_PX = 3;
	const MAX_BAR_PX = 18;
	// Raw RMS for speech is small (~0.05 quiet, ~0.2 loud); this gain on a sqrt
	// curve maps that range across the meter without clipping early.
	const LEVEL_GAIN = 2.4;

	function barHeight(envelope: number): number {
		return MIN_BAR_PX + envelope * level * (MAX_BAR_PX - MIN_BAR_PX);
	}

	const unlisteners: UnlistenFn[] = [];

	onMount(async () => {
		unlisteners.push(
			await recordingOverlayStatus.listen((event) => {
				status = event.payload;
			}),
			await recordingOverlayMicLevel.listen((event) => {
				const normalized = Math.min(1, Math.sqrt(event.payload) * LEVEL_GAIN);
				// Exponential smoothing so the bars glide instead of jittering.
				level = level * 0.6 + normalized * 0.4;
			}),
		);
		// Tell the main window we are ready so it re-sends the latest status.
		// Without this handshake the status emitted right after window creation
		// can land before our listener is attached.
		await recordingOverlayReady.emit();
	});

	onDestroy(() => {
		for (const unlisten of unlisteners) unlisten();
	});

	function sendAction(event: MouseEvent, action: RecordingOverlayAction) {
		// Don't let a button click bubble to the pill's focus-main handler:
		// stop/cancel should only stop/cancel, never reveal the main window.
		event.stopPropagation();
		void recordingOverlayAction.emit(action);
	}

	function focusMainWindow() {
		void revealMainWindow.emit({});
	}
</script>

<!-- The pill is a non-focusable overlay window, so it can never receive
     keyboard focus; clicking its body (not a button) just brings the main
     window forward. Keyboard handlers are moot here, hence the a11y ignores. -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="overlay"
	class:speaking={isSpeaking}
	title="Open Whispering"
	onclick={focusMainWindow}
>
	{#if isPolishing}
		<div class="icon">
			<LoaderCircleIcon class="size-4 animate-spin motion-reduce:animate-none" />
		</div>

		<div class="label">Polishing…</div>

		<div class="actions">
			<button
				type="button"
				class="action cancel"
				aria-label="Ship raw transcript now"
				title="Ship raw transcript now"
				onclick={(event) => sendAction(event, 'ship-raw')}
			>
				<XIcon class="size-4" />
			</button>
		</div>
	{:else}
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

		<div class="actions">
			<button
				type="button"
				class="action stop"
				aria-label={isManual ? 'Stop recording' : 'Stop listening'}
				title={isManual ? 'Stop recording' : 'Stop listening'}
				onclick={(event) => sendAction(event, 'stop')}
			>
				<SquareIcon class="size-3.5" />
			</button>
			{#if isManual}
				<button
					type="button"
					class="action cancel"
					aria-label="Cancel recording"
					title="Cancel recording"
					onclick={(event) => sendAction(event, 'cancel')}
				>
					<XIcon class="size-4" />
				</button>
			{/if}
		</div>
	{/if}
</div>

<style>
	/* This `:global` body rule is safe because this route is only ever loaded
	   in the dedicated overlay webview, which is a separate Tauri window with
	   its own document. The main app window never navigates here, so its
	   document background is untouched. (The isolation comes from the separate
	   webview document, not from Svelte's component scoping or route-level CSS
	   splitting.) */
	:global(html),
	:global(body) {
		background: transparent !important;
		margin: 0;
		overflow: hidden;
		/* The app shell forces a dark theme (ModeWatcher sets color-scheme:dark),
		   which makes the browser paint a dark canvas behind the pill in this
		   transparent webview. Reset it so only the pill is visible. */
		color-scheme: normal !important;
	}

	/* The Svelte inspector toggle (svelte.config.js `showToggleButton: always`)
	   is injected into every dev document, including this overlay webview where
	   it overlaps the pill. Hide it here; this rule lives only in the overlay
	   webview's document, and the host element does not exist in production. */
	:global(#svelte-inspector-host) {
		display: none !important;
	}

	.overlay {
		display: grid;
		grid-template-columns: auto 1fr auto;
		align-items: center;
		gap: 8px;
		height: 100vh;
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
		/* The body is clickable (opens the main window); the action buttons
		   stop propagation so only the empty areas trigger it. */
		cursor: pointer;
	}

	.icon {
		display: flex;
		align-items: center;
		color: rgba(255, 255, 255, 0.85);
	}

	/* The polishing pill swaps the mic-level bars for a single label that fills
	   the same center column. */
	.label {
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 13px;
		font-weight: 500;
		color: rgba(255, 255, 255, 0.92);
		white-space: nowrap;
	}

	.bars {
		display: flex;
		align-items: center;
		justify-content: center;
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
