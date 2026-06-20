import { debounce } from '@epicenter/workspace';
import { on } from 'svelte/events';
import type { Key, KeyBinding, Modifier } from '$lib/tauri/commands';
import {
	domCodeToKey,
	eventModifiers,
	isEmptyBinding,
} from '$lib/utils/key-binding';

const CAPTURE_WINDOW_MS = 300; // Time to wait for additional keys in a combination.

/**
 * The shared physical chord recorder: captures a gesture straight from the
 * webview's `keydown` stream in physical-key space (modifier flags plus a
 * physical `.code`), producing a `KeyBinding`. Both shortcut recorders use it for
 * capture; what they accept differs by policy, not by capture. It can only see
 * what the browser exposes, so Fn and modifier-only holds are invisible here and
 * stay the global tap's job (the global recorder switches to the native tap once
 * Accessibility is granted); the in-app recorder accepts whatever it yields.
 *
 * The completion model: each new key extends a 300ms window, and the gesture
 * commits when every key releases (immediate) or the window expires (the safety
 * net for the macOS quirk where a key's `keyup` is swallowed while a modifier is
 * still held). `onCapture` receives each captured `KeyBinding`; the recorder then
 * resets and keeps listening, so the owner can refuse a binding and let the user
 * try again without re-opening. The owner calls `stop()` once a capture is
 * accepted. Escape is left to bubble; the session owner cancels.
 */
export function createChordRecorder({
	onCapture,
}: {
	onCapture: (binding: KeyBinding) => void;
}) {
	// Internal control-flow guard only (the owner tracks its own session state), so
	// a plain bool, not reactive.
	let isListening = false;
	// Accumulated across the capture window: the modifiers ever held (a combo built
	// up over several presses) and the last physical key seen.
	let capturedModifiers: Modifier[] = [];
	let capturedKey: Key | null = null;
	// Every physical code currently down (modifiers included), so "all released"
	// can fire an immediate commit; the window covers any keyup the OS swallows.
	const heldCodes = new Set<string>();
	let detach: (() => void) | undefined;

	function reset() {
		capturedModifiers = [];
		capturedKey = null;
		heldCodes.clear();
	}

	function commit() {
		if (!isListening) return;
		completeAfterWindow.cancel();
		const binding: KeyBinding = {
			modifiers: capturedModifiers,
			keys: capturedKey ? [capturedKey] : [],
		};
		// Stay listening: the owner decides whether to accept (and stop us) or
		// refuse a non-chord; reset so the next attempt starts clean either way.
		reset();
		if (!isEmptyBinding(binding)) onCapture(binding);
	}

	// Quiet for CAPTURE_WINDOW_MS after the last key change = the gesture is done.
	const completeAfterWindow = debounce(commit, CAPTURE_WINDOW_MS);

	function onKeydown(e: KeyboardEvent) {
		if (e.repeat) return; // auto-repeat is not a new key
		if (e.key === 'Escape') return; // let it bubble; the session owner cancels
		// Keep the gesture from triggering anything in the webview while recording.
		e.preventDefault();

		heldCodes.add(e.code);
		// Union the modifiers (a combo built up over several presses), and take the
		// latest physical key. A modifier-only keydown just extends the window so
		// the user has time to add the key before it times out.
		for (const modifier of eventModifiers(e)) {
			if (!capturedModifiers.includes(modifier))
				capturedModifiers.push(modifier);
		}
		const key = domCodeToKey(e.code);
		if (key) capturedKey = key;

		completeAfterWindow();
	}

	function onKeyup(e: KeyboardEvent) {
		heldCodes.delete(e.code);
		if (heldCodes.size === 0) commit();
	}

	function start() {
		if (isListening) return;
		isListening = true;
		reset();
		const offKeydown = on(window, 'keydown', onKeydown);
		const offKeyup = on(window, 'keyup', onKeyup);
		// Losing focus mid-capture would strand held keys; drop them so a stale
		// modifier cannot wedge into the next gesture.
		const offBlur = on(window, 'blur', reset);
		detach = () => {
			offKeydown();
			offKeyup();
			offBlur();
		};
	}

	function stop() {
		if (!isListening) return;
		isListening = false;
		completeAfterWindow.cancel();
		reset();
		detach?.();
		detach = undefined;
	}

	return { start, stop };
}
