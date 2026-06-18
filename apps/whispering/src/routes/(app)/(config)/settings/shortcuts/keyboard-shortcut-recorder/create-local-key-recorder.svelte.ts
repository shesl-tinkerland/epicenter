import { debounce } from '@epicenter/workspace';
import type { KeyboardEventSupportedKey } from '$lib/constants/keyboard';
import type { PressedKeys } from '$lib/utils/createPressedKeys.svelte';

const CAPTURE_WINDOW_MS = 300; // Time to wait for additional keys in a combination

/**
 * Creates a keyboard shortcut recorder that captures key combinations
 *
 * How it works:
 * 1. When recording starts, any pressed keys are captured
 * 2. Each new key extends a 300ms capture window
 * 3. The combination completes when:
 *    - All keys are released (immediate), OR
 *    - The capture window expires (300ms after last key)
 * 4. Escape key cancels recording at any time
 *
 * This approach handles all common patterns:
 * - Quick taps (Ctrl+C)
 * - Held modifiers (Cmd+Shift+P)
 * - Single keys (F5)
 * - Complex combinations built over time
 */
export function createLocalKeyRecorder({
	pressedKeys,
	onRegister,
	onClear,
}: {
	pressedKeys: PressedKeys;
	onRegister: (keyCombination: KeyboardEventSupportedKey[]) => void;
	onClear: () => void;
}) {
	// State
	let isListening = $state(false);
	const capturedKeys = new Set<KeyboardEventSupportedKey>();

	// Helper: Complete the key combination
	function completeRecording() {
		if (!isListening || capturedKeys.size === 0) return;

		completeAfterWindow.cancel();
		isListening = false;

		// Convert Set to Array for registration
		const combination = Array.from(capturedKeys);
		capturedKeys.clear();

		onRegister(combination);
	}

	// Each new key restarts this window; it fires once the pressed keys
	// have stayed quiet for CAPTURE_WINDOW_MS.
	const completeAfterWindow = debounce(completeRecording, CAPTURE_WINDOW_MS);

	// Main effect: Watch for key changes
	$effect(() => {
		if (!isListening) return;

		// Escape key cancels recording
		if (pressedKeys.current.includes('escape')) {
			isListening = false;
			completeAfterWindow.cancel();
			capturedKeys.clear();
			return;
		}

		// Track new keys
		let hasNewKeys = false;
		for (const key of pressedKeys.current) {
			if (!capturedKeys.has(key)) {
				capturedKeys.add(key);
				hasNewKeys = true;
			}
		}

		// New keys extend the capture window
		if (hasNewKeys && capturedKeys.size > 0) {
			completeAfterWindow();
		}

		// All keys released = immediate completion
		if (pressedKeys.current.length === 0 && capturedKeys.size > 0) {
			completeRecording();
		}
	});

	// Public API
	return {
		get isListening() {
			return isListening;
		},
		start() {
			isListening = true;
			capturedKeys.clear();
			completeAfterWindow.cancel();
		},
		stop() {
			isListening = false;
			capturedKeys.clear();
			completeAfterWindow.cancel();
		},
		clear() {
			isListening = false;
			capturedKeys.clear();
			completeAfterWindow.cancel();
			onClear();
		},
		register: onRegister,
	};
}

export type LocalKeyRecorder = ReturnType<typeof createLocalKeyRecorder>;
