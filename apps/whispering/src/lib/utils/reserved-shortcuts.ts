/**
 * Reserved-shortcut policy for desktop global gestures (the structured
 * `KeyBinding` the rdev backend matches on, in physical-key space). Pure: no
 * Tauri or DOM dependency.
 *
 * Desktop bindings fire system-wide, so a few rules keep a gesture from
 * shadowing something the OS or foreground app owns:
 * - A short list of common OS/app chords (reload, clipboard, undo/redo, close,
 *   quit, app switch, screenshots, system search) is refused outright.
 * - A gesture must carry a modifier or Fn, so it cannot fire on an ordinary
 *   keypress.
 */

import type { Modifier } from '$lib/tauri/commands';
import type { BindingLike } from '$lib/utils/key-binding';

/**
 * `primary` stands for the platform's command modifier: Command on macOS,
 * Control on Windows/Linux. A reserved entry using it expands to both, so the
 * same table covers Cmd+R and Ctrl+R without per-platform branching.
 */
type ModifierToken = Modifier | 'primary';

type ReservedChord = {
	modifiers: ModifierToken[];
	keys: string[];
	/** What the chord does, shown to the user when their pick is refused. */
	label: string;
};

/**
 * Common chords a global gesture must not shadow. Matched as exact set equality
 * (after expanding `primary`), so a precise combo is blocked while a superset
 * the user deliberately built (for example the Windows toggle Ctrl+Win+Space) is
 * not. Keys are physical-position names from the `Key` vocabulary.
 */
const RESERVED_CHORDS: ReservedChord[] = [
	// Reload
	{ modifiers: ['primary'], keys: ['keyR'], label: 'Reload' },
	{ modifiers: ['primary', 'shift'], keys: ['keyR'], label: 'Hard reload' },
	{ modifiers: [], keys: ['f5'], label: 'Reload' },
	// Clipboard
	{ modifiers: ['primary'], keys: ['keyC'], label: 'Copy' },
	{ modifiers: ['primary'], keys: ['keyV'], label: 'Paste' },
	{ modifiers: ['primary'], keys: ['keyX'], label: 'Cut' },
	// Undo / redo
	{ modifiers: ['primary'], keys: ['keyZ'], label: 'Undo' },
	{ modifiers: ['primary', 'shift'], keys: ['keyZ'], label: 'Redo' },
	{ modifiers: ['ctrl'], keys: ['keyY'], label: 'Redo' },
	// Document basics
	{ modifiers: ['primary'], keys: ['keyA'], label: 'Select all' },
	{ modifiers: ['primary'], keys: ['keyS'], label: 'Save' },
	{ modifiers: ['primary'], keys: ['keyF'], label: 'Find' },
	{ modifiers: ['primary'], keys: ['keyP'], label: 'Print' },
	// Windows, tabs, app lifecycle
	{ modifiers: ['primary'], keys: ['keyN'], label: 'New window' },
	{ modifiers: ['primary'], keys: ['keyT'], label: 'New tab' },
	{ modifiers: ['primary'], keys: ['keyW'], label: 'Close window or tab' },
	{ modifiers: ['primary'], keys: ['keyQ'], label: 'Quit application' },
	{ modifiers: ['alt'], keys: ['f4'], label: 'Close window' },
	// Application / window switching
	{ modifiers: ['primary'], keys: ['tab'], label: 'Switch application' },
	{ modifiers: ['alt'], keys: ['tab'], label: 'Switch window' },
	// System search (macOS Spotlight / input source). Literal `meta`, so the
	// Windows Ctrl+Win+Space toggle (a different set) stays allowed.
	{ modifiers: ['meta'], keys: ['space'], label: 'System search' },
	// Screenshots
	{ modifiers: ['primary', 'shift'], keys: ['num3'], label: 'Screenshot' },
	{ modifiers: ['primary', 'shift'], keys: ['num4'], label: 'Screenshot' },
	{ modifiers: ['primary', 'shift'], keys: ['num5'], label: 'Screenshot' },
	{ modifiers: ['meta', 'shift'], keys: ['keyS'], label: 'Screenshot' },
];

function sameSet(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	const set = new Set(a);
	return b.every((value) => set.has(value));
}

/** Expand a reserved chord's `primary` token into concrete modifier sets. */
function expandModifiers(modifiers: ModifierToken[]): Modifier[][] {
	if (!modifiers.includes('primary')) {
		return [modifiers as Modifier[]];
	}
	const base = modifiers.filter((m): m is Modifier => m !== 'primary');
	return [
		[...base, 'meta'],
		[...base, 'ctrl'],
	];
}

function matchesReserved(binding: BindingLike, chord: ReservedChord): boolean {
	if (!sameSet(binding.keys, chord.keys)) return false;
	return expandModifiers(chord.modifiers).some((modifiers) =>
		sameSet(binding.modifiers, modifiers),
	);
}

/**
 * Validate a desktop global gesture against the reserved-shortcut policy.
 * Returns `null` when the gesture is allowed, or a human-readable reason when it
 * is refused. (Domain state, not an operation failure, so a plain `string | null`
 * rather than a `Result`.)
 *
 * An empty binding (no modifiers, no keys) is treated as "unset" and passes;
 * clearing a gesture is the caller's job, not this check's.
 */
export function validateGlobalBinding(binding: BindingLike): string | null {
	const hasNothing =
		binding.modifiers.length === 0 && binding.keys.length === 0;
	if (hasNothing) return null;

	for (const chord of RESERVED_CHORDS) {
		if (matchesReserved(binding, chord)) {
			return `That combination is reserved by the system or app (${chord.label}). Pick another.`;
		}
	}

	if (binding.modifiers.length === 0) {
		return 'Add a modifier or Fn so the gesture cannot fire on an ordinary keypress.';
	}

	return null;
}
