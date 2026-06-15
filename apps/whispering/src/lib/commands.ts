import {
	cancelRecording,
	startManualRecording,
	stopManualRecording,
	toggleManualRecording,
	toggleVadRecording,
} from '$lib/operations/recording';
import { runTransformationOnClipboard } from '$lib/operations/transformation-clipboard';
import { openTransformationPicker } from '$lib/operations/transformation-picker';

/**
 * Registry of available commands in the application.
 * Defines what commands exist and how they're triggered (keyboard shortcuts,
 * voice, command palette, etc.).
 *
 * The actual command implementations live in $lib/operations/* as plain async
 * functions that can be invoked from anywhere in the UI, not just through this
 * command registry.
 */

/**
 * The keyboard event state passed to callbacks: a trigger backend reports
 * either the press or the release edge. Both the desktop rdev backend (which
 * emits the generated `TriggerState`) and the browser keydown backend speak
 * this exact pair, so the command layer is the single point where they
 * converge.
 */
export type ShortcutEventState = 'Pressed' | 'Released';

type SatisfiedCommand = {
	id: string;
	title: string;
	/**
	 * When to trigger the callback.
	 * - ['Pressed']: Only on key press
	 * - ['Released']: Only on key release
	 * - ['Pressed', 'Released']: On both press and release
	 */
	on: ShortcutEventState[];
	callback: (state?: ShortcutEventState) => void;
};

export const commands = [
	{
		id: 'pushToTalk',
		title: 'Push to talk',
		on: ['Pressed', 'Released'],
		callback: (state?: ShortcutEventState) => {
			if (state === 'Pressed') {
				startManualRecording();
			} else if (state === 'Released') {
				stopManualRecording();
			}
		},
	},
	{
		id: 'toggleManualRecording',
		title: 'Toggle recording',
		on: ['Pressed'],
		callback: () => toggleManualRecording(),
	},
	{
		id: 'cancelRecording',
		title: 'Cancel recording',
		on: ['Pressed'],
		callback: () => cancelRecording(),
	},
	{
		id: 'toggleVadRecording',
		title: 'Toggle voice activated recording',
		on: ['Pressed'],
		callback: () => toggleVadRecording(),
	},
	{
		id: 'openTransformationPicker',
		title: 'Open transformation picker',
		// Fire on release, not press: the global accelerator carries a Cmd/Ctrl+Shift
		// chord, and capturing on press synthesizes Cmd/Ctrl+C while that chord is
		// still held, so the foreground app sees Cmd+Shift+C instead of a clean copy.
		// Register both states (not Released-only) because the local shortcut manager
		// only arms a command on keydown when `on` includes 'Pressed'; without it the
		// in-app shortcut would never fire. The callback guard runs once, on release.
		on: ['Pressed', 'Released'],
		callback: (state?: ShortcutEventState) => {
			if (state === 'Released' || state === undefined)
				openTransformationPicker();
		},
	},
	{
		id: 'runTransformationOnClipboard',
		title: 'Run transformation on clipboard',
		on: ['Pressed'],
		callback: () => runTransformationOnClipboard(),
	},
] as const satisfies SatisfiedCommand[];

export type Command = (typeof commands)[number];

type CommandCallbacks = Record<Command['id'], Command['callback']>;

export const commandCallbacks = commands.reduce<CommandCallbacks>(
	(acc, command) => {
		acc[command.id] = command.callback;
		return acc;
	},
	{} as CommandCallbacks,
);
