<script lang="ts">
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import { onDestroy, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { commandCallbacks } from '$lib/commands';
	import { analytics } from '$lib/operations/analytics';
	import {
		cancelRecording,
		stopManualRecording,
		stopVadRecording,
	} from '$lib/operations/recording';
	import {
		RECORDING_OVERLAY_ACTION,
		RECORDING_OVERLAY_FOCUS_MAIN,
		type RecordingOverlayAction,
		type RecordingOverlayStatus,
	} from '$lib/recording-overlay/events';
	import { installGlobalShortcutRuntime } from '$lib/runtime/global-shortcuts.svelte';
	import { installUnloadPolicyRuntime } from '$lib/runtime/unload-policy.svelte';
	import { services } from '$lib/services';
	import { localModel } from '$lib/state/local-model.svelte';
	import { manualRecorder } from '$lib/state/manual-recorder.svelte';
	import { recordings } from '$lib/state/recordings.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { vadRecorder } from '$lib/state/vad-recorder.svelte';
	import { recordingOverlay } from '#platform/recording-overlay';
	import { tauri } from '#platform/tauri';
	import { checkForUpdates } from '../_runtime/check-for-updates';
	import { registerAccessibilityPermission } from '../_runtime/register-accessibility-permission';
	import {
		resetGlobalShortcutsToDefaultIfDuplicates,
		resetLocalShortcutsToDefaultIfDuplicates,
		syncLocalShortcutsWithSettings,
	} from '$lib/operations/shortcuts';
	import { registerOnboarding } from '../_runtime/register-onboarding';
	import { syncIconWithRecorderState } from '../_runtime/syncIconWithRecorderState.svelte';

	// Headless component: the single, stable owner of everything that starts when
	// Whispering starts. It mounts once at the session root, outside the
	// responsive nav branch, so crossing a layout breakpoint never re-runs any of
	// this. That is the whole point: "once per launch" is structural here, not a
	// guarded flag.

	let cleanupAccessibilityPermission: (() => void) | undefined;
	let cleanupShortcutListener: (() => void) | undefined;
	let shortcutListenerDestroyed = false;
	let unlistenNavigate: UnlistenFn | undefined;
	let unlistenLocalModel: UnlistenFn | undefined;
	let unlistenOverlayAction: UnlistenFn | undefined;
	let unlistenOverlayFocus: UnlistenFn | undefined;

	// Single source of truth for what the overlay should show: the active
	// recorder, with manual taking precedence over VAD so the two can never
	// fight over the one overlay window if both are briefly non-idle. Both the
	// sync effect and the action handler in onMount read this, so the precedence
	// rule lives in exactly one place. `null` when idle.
	const overlayStatus = $derived.by((): RecordingOverlayStatus | null => {
		if (manualRecorder.state === 'RECORDING')
			return { mode: 'manual', state: 'RECORDING' };
		if (
			vadRecorder.state === 'LISTENING' ||
			vadRecorder.state === 'SPEECH_DETECTED'
		)
			return { mode: 'vad', state: vadRecorder.state };
		return null;
	});

	// Recorder-window mirror (desktop only): the tray icon tracks the active
	// recorder state.
	if (tauri) {
		syncIconWithRecorderState(tauri);
	}

	// Project frontend-owned settings into native runtime state. Both install a
	// reconciler `$effect` at this init site (so they get an owner) and no-op on
	// web. The unload policy reconciles a value into Rust's idle clock; the
	// global-shortcut runtime supervises the rdev listener and converges its
	// bindings from device config. Neither mirrors authority: the FE owns values,
	// native owns mechanism.
	installUnloadPolicyRuntime();
	installGlobalShortcutRuntime();

	// In-app (local) keydown shortcut listener. Runs on every platform; the
	// desktop global backend is separate and started below.
	$effect(() => {
		const unlisten = services.localShortcutManager.listen();
		return () => unlisten();
	});

	// Log app started once on mount.
	$effect(() => {
		analytics.logEvent({ type: 'app_started' });
	});

	// Mirror the active recorder into the overlay window. On web the seam is a
	// no-op.
	$effect(() => {
		recordingOverlay.sync(overlayStatus);
	});

	// Transcription config is no longer mirrored to Rust here: it travels with
	// each transcribe call as a per-call `TranscriptionSpec`, built where it is
	// consumed in `dispatchLocalTranscription`, so nothing ambient can go stale.

	// Retention pruning: keep at most `maxCount` settled recordings.
	$effect(() => {
		const strategy = settings.get('retention.strategy');
		if (strategy === 'keep-forever') return;

		// `keep-none` keeps zero recordings; it maps to a runtime count of 0
		// without ever persisting 0 (the schema enforces `maxCount >= 1`).
		const maxCount =
			strategy === 'keep-none' ? 0 : settings.get('retention.maxCount');

		// Only settled recordings are eligible for pruning. A recording still
		// in the pipeline has `transcription: null`; deleting it would pull the
		// audio blob out from under transcription, which reads it back by id.
		// So `keep-none` deletes each recording once its transcription settles,
		// never before, which is the window the recording needs to be usable.
		const settledIds = recordings.sorted
			.filter((recording) => recording.transcription !== null)
			.map((recording) => recording.id);
		if (settledIds.length <= maxCount) return;

		const idsToDelete = settledIds.slice(maxCount);
		// Delete audio blobs from storage
		services.blobs.audio.delete(idsToDelete);
		// Delete recording metadata from workspace (single-scan bulk)
		recordings.bulkDelete(idsToDelete);
	});

	onMount(() => {
		// Expose imperative helpers for debugging and deep links.
		window.commands = commandCallbacks;
		window.goto = goto;

		// Cross-platform startup facts.
		registerOnboarding();
		// Standing macOS Accessibility signal: this poll keeps
		// `environment.accessibilityGranted` current; the global-shortcut runtime
		// subscribes to it to decide when the rdev listener may start. No one-shot
		// callback: the runtime reconciles, it is not pushed to.
		cleanupAccessibilityPermission = registerAccessibilityPermission();

		// One trigger backend per platform: desktop uses the rdev global listener
		// exclusively, the browser uses in-app keydown exclusively. They never
		// both bind on the same platform.
		if (tauri) {
			void tauri.globalShortcuts.startListening().then((unlisten) => {
				// If the session root was torn down (e.g. navigating out of the app
				// group) before this resolved, drop the listener now so it can't leak
				// past teardown. This owner mounts once and never remounts, so there
				// is no remount race to guard, only this teardown one.
				if (shortcutListenerDestroyed) unlisten();
				else cleanupShortcutListener = unlisten;
			});
			// Binding registration and listener start-up are owned by
			// `installGlobalShortcutRuntime()` (above), which reconciles them from
			// device config plus the accessibility/liveness signals.
			resetGlobalShortcutsToDefaultIfDuplicates();

			// Desktop-only async check - fire and forget
			void checkForUpdates();

			// Listen for navigation from other windows and subscribe to the
			// local-model lifecycle so any consumer (`localModel.isBusy`, etc.) can
			// react to load / inference / eviction events.
			void (async () => {
				unlistenNavigate = await listen<{ path: string }>(
					'navigate-main-window',
					(event) => {
						goto(event.payload.path);
					},
				);
				// Route overlay button clicks against the live recorder state rather
				// than the overlay's payload: a click can race a state change, so we
				// act on `overlayStatus` (derived from the recorder that is actually
				// active), not on what the overlay thought it was showing.
				unlistenOverlayAction = await listen<RecordingOverlayAction>(
					RECORDING_OVERLAY_ACTION,
					(event) => {
						if (!overlayStatus) return;
						if (overlayStatus.mode === 'manual') {
							if (event.payload === 'cancel') void cancelRecording();
							else void stopManualRecording();
							return;
						}
						// VAD only supports stopping, never cancelling. Ignore a stale
						// cancel (e.g. a manual cancel that lands just as VAD starts).
						if (event.payload === 'stop') void stopVadRecording();
					},
				);
				// Clicking the overlay pill body asks the main window to come forward.
				unlistenOverlayFocus = await listen(RECORDING_OVERLAY_FOCUS_MAIN, () => {
					const mainWindow = getCurrentWindow();
					void (async () => {
						await mainWindow.show();
						await mainWindow.unminimize();
						// setFocus often rejects on macOS; the show/unminimize above is
						// what actually surfaces the window, so a failure here is fine.
						await mainWindow.setFocus().catch(() => {});
					})();
				});
				unlistenLocalModel = await localModel.attach();
			})();
		} else {
			syncLocalShortcutsWithSettings();
			resetLocalShortcutsToDefaultIfDuplicates();
		}
	});

	onDestroy(() => {
		cleanupAccessibilityPermission?.();
		shortcutListenerDestroyed = true;
		cleanupShortcutListener?.();
		unlistenNavigate?.();
		unlistenOverlayAction?.();
		unlistenOverlayFocus?.();
		unlistenLocalModel?.();
	});
</script>
