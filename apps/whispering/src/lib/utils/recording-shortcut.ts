import { shortcuts } from '#platform/shortcuts';
import type { Command } from '$lib/commands';

/**
 * Preference order for the shortcut that starts each recording mode: the first
 * command with a binding live on this platform wins.
 *
 * Manual recording has two start commands. Desktop binds push-to-talk (Fn) by
 * default and ships the tap-toggle unbound; the browser ships push-to-talk
 * unbound and the toggle bound. So push-to-talk leads and the toggle backs it
 * up, and whichever the user actually bound is the one we show. VAD has a single
 * command, so its list has one entry.
 */
const RECORDING_SHORTCUT_PREFERENCE = {
	manual: ['pushToTalk', 'toggleManualRecording'],
	vad: ['toggleVadRecording'],
} as const satisfies Record<string, readonly Command['id'][]>;

export type RecordingShortcutMode = keyof typeof RECORDING_SHORTCUT_PREFERENCE;

/**
 * The display label for the shortcut that actually starts this recording mode on
 * this platform, resolved through the `#platform/shortcuts` label seam.
 *
 * Reading a single command (`shortcuts.label('toggleManualRecording')`) rendered
 * an empty key on a fresh desktop install, where the toggle ships unbound and
 * push-to-talk (Fn) is the gesture that works. Routing through the preference
 * list shows the bound gesture instead. Returns `''` when nothing in the list is
 * bound; callers hide the hint and fall back to "click".
 */
export function getRecordingShortcutLabel(mode: RecordingShortcutMode): string {
	for (const commandId of RECORDING_SHORTCUT_PREFERENCE[mode]) {
		const label = shortcuts.currentLabel(commandId);
		if (label) return label;
	}
	return '';
}
