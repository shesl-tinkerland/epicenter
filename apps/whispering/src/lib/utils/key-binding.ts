/**
 * Display helpers for the desktop `KeyBinding` shape (the structured binding the
 * rdev backend matches on). Pure: no Tauri or DOM dependency.
 */

import type { Key, KeyBinding, Modifier } from '$lib/tauri/commands';

/**
 * A binding for display/dedup purposes. Accepts both the IPC `KeyBinding`
 * (`keys: Key[]`) and the stored shape (`keys: string[]`, validated structurally
 * in device-config and by name in Rust), so the same helpers serve both.
 */
export type BindingLike = {
	modifiers: readonly Modifier[];
	keys: readonly string[];
};

const MODIFIER_LABELS_APPLE: Record<Modifier, string> = {
	ctrl: '⌃',
	alt: '⌥',
	shift: '⇧',
	meta: '⌘',
	fn: 'fn',
};

const MODIFIER_LABELS_OTHER: Record<Modifier, string> = {
	ctrl: 'Ctrl',
	alt: 'Alt',
	shift: 'Shift',
	meta: 'Super',
	fn: 'Fn',
};

// Fixed display order so the same binding always renders the same way.
const MODIFIER_ORDER: Modifier[] = ['ctrl', 'alt', 'shift', 'meta', 'fn'];

const KEY_LABELS: Record<string, string> = {
	space: 'Space',
	return: 'Enter',
	tab: 'Tab',
	escape: 'Esc',
	backspace: '⌫',
	delete: 'Del',
	insert: 'Ins',
	upArrow: '↑',
	downArrow: '↓',
	leftArrow: '←',
	rightArrow: '→',
	home: 'Home',
	end: 'End',
	pageUp: 'PgUp',
	pageDown: 'PgDn',
	minus: '-',
	equal: '=',
	leftBracket: '[',
	rightBracket: ']',
	semiColon: ';',
	quote: "'",
	backQuote: '`',
	backSlash: '\\',
	comma: ',',
	dot: '.',
	slash: '/',
};

function keyLabel(key: string): string {
	const named = KEY_LABELS[key];
	if (named) return named;
	if (key.startsWith('key')) return key.slice(3); // keyD -> D
	if (key.startsWith('num')) return key.slice(3); // num1 -> 1
	if (/^f\d+$/.test(key)) return key.toUpperCase(); // f1 -> F1
	return key;
}

/**
 * Render a binding as a compact label: `⌘⇧D` on macOS, `Ctrl+Shift+D`
 * elsewhere. Modifiers come first in a fixed order, then keys. An empty binding
 * renders as the empty string (callers show a placeholder).
 */
export function keyBindingToLabel(
	binding: BindingLike,
	isApple: boolean,
): string {
	const labels = isApple ? MODIFIER_LABELS_APPLE : MODIFIER_LABELS_OTHER;
	const separator = isApple ? '' : '+';
	const modifiers = MODIFIER_ORDER.filter((modifier) =>
		binding.modifiers.includes(modifier),
	).map((modifier) => labels[modifier]);
	const keys = binding.keys.map(keyLabel);
	return [...modifiers, ...keys].join(separator);
}

/** A binding with no modifiers and no keys can never fire; treat it as unset. */
export function isEmptyBinding(binding: BindingLike): boolean {
	return binding.modifiers.length === 0 && binding.keys.length === 0;
}

/** Whether every modifier and key of `subset` is also present in `superset`. */
function isContainedBy(subset: BindingLike, superset: BindingLike): boolean {
	return (
		subset.modifiers.every((m) => superset.modifiers.includes(m)) &&
		subset.keys.every((k) => superset.keys.includes(k))
	);
}

/**
 * Whether two gestures overlap: one is a subset of the other (including equal).
 * The rdev matcher fires on exact set equality with no prefix resolution, so an
 * overlapping pair is unusable: the shorter gesture fires first and shadows the
 * longer. The recorder refuses to save a gesture that overlaps another, which is
 * why a key bound to one gesture (such as push-to-talk's Fn) cannot appear in
 * any other.
 */
export function bindingsOverlap(a: BindingLike, b: BindingLike): boolean {
	return isContainedBy(a, b) || isContainedBy(b, a);
}

const MANUAL_MODIFIER_ALIASES: Record<string, Modifier> = {
	cmd: 'meta',
	command: 'meta',
	meta: 'meta',
	super: 'meta',
	win: 'meta',
	windows: 'meta',
	ctrl: 'ctrl',
	control: 'ctrl',
	alt: 'alt',
	option: 'alt',
	opt: 'alt',
	shift: 'shift',
	fn: 'fn',
};

const MANUAL_KEY_ALIASES: Record<string, Key> = {
	space: 'space',
	enter: 'return',
	return: 'return',
	tab: 'tab',
	esc: 'escape',
	escape: 'escape',
	backspace: 'backspace',
	delete: 'delete',
	del: 'delete',
	insert: 'insert',
	ins: 'insert',
	up: 'upArrow',
	down: 'downArrow',
	left: 'leftArrow',
	right: 'rightArrow',
	home: 'home',
	end: 'end',
	pageup: 'pageUp',
	pagedown: 'pageDown',
	';': 'semiColon',
	"'": 'quote',
	',': 'comma',
	'.': 'dot',
	'/': 'slash',
	'-': 'minus',
	'=': 'equal',
	'[': 'leftBracket',
	']': 'rightBracket',
	'\\': 'backSlash',
	'`': 'backQuote',
};

function manualKey(token: string): Key | null {
	if (/^[a-z]$/.test(token)) return `key${token.toUpperCase()}` as Key;
	if (/^[0-9]$/.test(token)) return `num${token}` as Key;
	if (/^f([1-9]|1[0-9]|2[0-4])$/.test(token)) return token as Key;
	return MANUAL_KEY_ALIASES[token] ?? null;
}

/**
 * Parse a typed combo like `cmd+shift+d`, `fn+space`, or `ctrl+alt` into a
 * `KeyBinding`. The manual-entry fallback in the recorder; lenient on modifier
 * spelling. At most one key (rdev bindings carry a single key); a token that is
 * neither a known modifier nor a known key fails the whole parse (returns null).
 */
export function parseManualBinding(input: string): KeyBinding | null {
	const tokens = input
		.split('+')
		.map((token) => token.trim())
		.filter(Boolean);
	if (tokens.length === 0) return null;

	const modifiers: Modifier[] = [];
	const keys: Key[] = [];
	for (const token of tokens) {
		const lower = token.toLowerCase();
		const modifier = MANUAL_MODIFIER_ALIASES[lower];
		if (modifier) {
			if (!modifiers.includes(modifier)) modifiers.push(modifier);
			continue;
		}
		const key = manualKey(lower);
		if (!key) return null;
		keys.push(key);
	}

	if (keys.length > 1) return null;
	if (modifiers.length === 0 && keys.length === 0) return null;
	return { modifiers, keys };
}
