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

/**
 * Accelerator modifier tokens for `tauri-plugin-global-shortcut`. `meta` becomes
 * `Super`, which the global-hotkey parser maps to Command on macOS and the
 * Super/Windows key elsewhere. `fn` has no accelerator spelling (Carbon's
 * `RegisterEventHotKey` cannot bind it), so a binding that needs Fn is not a
 * Tier-0 chord and {@link keyBindingToAccelerator} returns `null` for it.
 */
const ACCELERATOR_MODIFIERS: Record<Modifier, string | null> = {
	ctrl: 'Control',
	alt: 'Alt',
	shift: 'Shift',
	meta: 'Super',
	fn: null,
};

/** `Key` -> a global-hotkey `Code` token (the parser is case-insensitive). */
const ACCELERATOR_KEYS: Record<string, string> = {
	space: 'Space',
	return: 'Enter',
	tab: 'Tab',
	escape: 'Escape',
	backspace: 'Backspace',
	delete: 'Delete',
	insert: 'Insert',
	upArrow: 'ArrowUp',
	downArrow: 'ArrowDown',
	leftArrow: 'ArrowLeft',
	rightArrow: 'ArrowRight',
	home: 'Home',
	end: 'End',
	pageUp: 'PageUp',
	pageDown: 'PageDown',
	minus: 'Minus',
	equal: 'Equal',
	leftBracket: 'BracketLeft',
	rightBracket: 'BracketRight',
	semiColon: 'Semicolon',
	quote: 'Quote',
	backQuote: 'Backquote',
	backSlash: 'Backslash',
	comma: 'Comma',
	dot: 'Period',
	slash: 'Slash',
};

function acceleratorKey(key: string): string | null {
	const named = ACCELERATOR_KEYS[key];
	if (named) return named;
	if (/^key[A-Z]$/.test(key)) return `Key${key.slice(3)}`; // keyD -> KeyD
	if (/^num[0-9]$/.test(key)) return `Digit${key.slice(3)}`; // num1 -> Digit1
	if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return key.toUpperCase(); // f1 -> F1
	return null;
}

/**
 * Render a binding as a `tauri-plugin-global-shortcut` accelerator string (for
 * example `Control+Shift+Space`), or `null` when it is not a Tier-0 chord the
 * plugin can register. A binding is not Tier-0 when it carries Fn (no
 * accelerator spelling) or is not exactly one key plus at least one modifier:
 * Fn holds and modifier-only holds belong to the Tier-1 keyboard tap, which the
 * caller routes separately. Modifiers are emitted in a fixed order so the same
 * binding always produces the same accelerator.
 */
export function keyBindingToAccelerator(binding: BindingLike): string | null {
	const [key, ...rest] = binding.keys;
	if (!key || rest.length > 0) return null; // accelerators carry exactly one key
	if (binding.modifiers.length === 0) return null; // a bare key is not a gesture
	const modifiers: string[] = [];
	for (const modifier of MODIFIER_ORDER) {
		if (!binding.modifiers.includes(modifier)) continue;
		const token = ACCELERATOR_MODIFIERS[modifier];
		if (!token) return null; // fn -> Tier-1 tap, not the plugin
		modifiers.push(token);
	}
	const keyToken = acceleratorKey(key);
	if (!keyToken) return null;
	return [...modifiers, keyToken].join('+');
}

/**
 * Which backend can execute a binding. A Tier-0 `chord` registers through the
 * permission-free `tauri-plugin-global-shortcut` and carries the accelerator
 * string it registers under; a `tap` binding (an Fn or modifier-only hold) is
 * owned by the Tier-1 rdev tap behind the Accessibility grant and matched on its
 * structured `KeyBinding`, so it needs no accelerator.
 */
export type ResolvedBinding =
	| { tier: 'chord'; accelerator: string }
	| { tier: 'tap' };

/**
 * The single owner of the Tier-0/Tier-1 split. Resolves a binding to its backend
 * and, for a chord, computes the accelerator once here so the partition and the
 * plugin registration never re-derive it. {@link isTierZeroChord} is the boolean
 * view of this for callers that only need the predicate.
 */
export function resolveBinding(binding: BindingLike): ResolvedBinding {
	const accelerator = keyBindingToAccelerator(binding);
	return accelerator !== null
		? { tier: 'chord', accelerator }
		: { tier: 'tap' };
}

/**
 * Whether a binding is a Tier-0 chord: a gesture the permission-free
 * `tauri-plugin-global-shortcut` can register with no Accessibility grant. The
 * boolean view of {@link resolveBinding}; an Fn hold or a modifier-only hold is
 * not Tier-0 and belongs to the Tier-1 keyboard tap.
 */
export function isTierZeroChord(binding: BindingLike): boolean {
	return resolveBinding(binding).tier === 'chord';
}

/**
 * Inverse of {@link ACCELERATOR_KEYS}: a W3C `KeyboardEvent.code` token back to
 * our `Key`. Built from the same source so the two directions can never drift.
 */
const KEY_BY_ACCELERATOR_CODE: Record<string, string> = Object.fromEntries(
	Object.entries(ACCELERATOR_KEYS).map(([key, code]) => [code, key]),
);

/**
 * Map a physical `KeyboardEvent.code` (for example `KeyD`, `Digit1`, `Space`)
 * to our `Key`, or `null` when the code is not a bindable key (a modifier code
 * like `MetaLeft`, or anything outside the Tier-0 chord alphabet). Reading
 * `.code` not `.key` keeps capture in physical-key space, matching the rdev tap
 * and sidestepping the macOS Option-character problem the `.key`-based local
 * recorder has to normalize. The accepted set is exactly the one
 * {@link keyBindingToAccelerator} can spell, so a chord captured here always
 * routes to the permission-free plugin. The inverse of {@link acceleratorKey}.
 */
export function domCodeToKey(code: string): Key | null {
	const named = KEY_BY_ACCELERATOR_CODE[code];
	if (named) return named as Key;
	if (/^Key[A-Z]$/.test(code)) return `key${code.slice(3)}` as Key; // KeyD -> keyD
	if (/^Digit[0-9]$/.test(code)) return `num${code.slice(5)}` as Key; // Digit1 -> num1
	if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code.toLowerCase() as Key; // F1 -> f1
	return null;
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
 * why a key bound to one gesture (such as the recording key's Fn) cannot appear
 * in any other.
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
