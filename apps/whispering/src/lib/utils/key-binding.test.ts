import { expect, test } from 'bun:test';
import type { KeyBinding } from '$lib/tauri/commands';
import {
	type BindingLike,
	bindingsOverlap,
	domCodeToKey,
	isTierZeroChord,
	keyBindingToAccelerator,
	keyBindingToString,
	parseManualBinding,
	resolveBinding,
} from './key-binding';

test('a binding overlaps a superset of itself', () => {
	// Fn (push-to-talk) is contained by Fn+Space, so the pair is unusable.
	expect(
		bindingsOverlap(
			{ modifiers: ['fn'], keys: [] },
			{ modifiers: ['fn'], keys: ['space'] },
		),
	).toBe(true);
});

test('overlap is symmetric', () => {
	expect(
		bindingsOverlap(
			{ modifiers: ['fn'], keys: ['space'] },
			{ modifiers: ['fn'], keys: [] },
		),
	).toBe(true);
});

test('equal bindings overlap', () => {
	expect(
		bindingsOverlap(
			{ modifiers: ['meta'], keys: ['dot'] },
			{ modifiers: ['meta'], keys: ['dot'] },
		),
	).toBe(true);
});

test('a modifier-only hold is contained by any chord that adds to it', () => {
	expect(
		bindingsOverlap(
			{ modifiers: ['meta'], keys: [] },
			{ modifiers: ['meta'], keys: ['dot'] },
		),
	).toBe(true);
});

test('the shipped defaults do not overlap each other', () => {
	// Two gestures ship bound by default: toggle and cancel. Push-to-talk ships
	// unbound (opt into Fn behind the Accessibility tier), so it cannot collide.
	const toggle: BindingLike = { modifiers: ['meta', 'shift'], keys: ['space'] };
	const cancel: BindingLike = { modifiers: ['meta'], keys: ['dot'] };
	expect(bindingsOverlap(toggle, cancel)).toBe(false);
});

test('sibling chords sharing a modifier but differing in key do not overlap', () => {
	// Two Ctrl+Shift chords differing only in their final key (e.g. a user-bound
	// Ctrl+Shift+Space vs the Windows Ctrl+Shift+. cancel default).
	expect(
		bindingsOverlap(
			{ modifiers: ['ctrl', 'shift'], keys: ['space'] },
			{ modifiers: ['ctrl', 'shift'], keys: ['dot'] },
		),
	).toBe(false);
});

test('a chord maps to a global-hotkey accelerator', () => {
	// meta -> Super, space -> Space: the default macOS toggle. Modifiers emit in
	// the shared fixed order (shift before meta), which the parser accepts in any
	// order anyway.
	expect(
		keyBindingToAccelerator({ modifiers: ['meta', 'shift'], keys: ['space'] }),
	).toBe('Shift+Super+Space');
});

test('modifiers serialize in a fixed order regardless of input order', () => {
	expect(
		keyBindingToAccelerator({ modifiers: ['shift', 'ctrl'], keys: ['dot'] }),
	).toBe('Control+Shift+Period');
});

test('letter and digit keys map to Code tokens', () => {
	expect(keyBindingToAccelerator({ modifiers: ['ctrl'], keys: ['keyD'] })).toBe(
		'Control+KeyD',
	);
	expect(keyBindingToAccelerator({ modifiers: ['alt'], keys: ['num1'] })).toBe(
		'Alt+Digit1',
	);
});

test('an Fn binding is not a Tier-0 accelerator', () => {
	// Fn has no accelerator spelling; it belongs to the Tier-1 tap.
	expect(
		keyBindingToAccelerator({ modifiers: ['fn'], keys: ['space'] }),
	).toBeNull();
});

test('a modifier-only hold is not a Tier-0 accelerator', () => {
	expect(keyBindingToAccelerator({ modifiers: ['meta'], keys: [] })).toBeNull();
});

test('a bare key with no modifier is refused', () => {
	expect(keyBindingToAccelerator({ modifiers: [], keys: ['keyA'] })).toBeNull();
});

test('resolveBinding routes a chord to the plugin with its accelerator', () => {
	expect(
		resolveBinding({ modifiers: ['meta', 'shift'], keys: ['space'] }),
	).toEqual({ tier: 'chord', accelerator: 'Shift+Super+Space' });
});

test('resolveBinding routes Fn and modifier-only holds to the tap', () => {
	expect(resolveBinding({ modifiers: ['fn'], keys: ['space'] })).toEqual({
		tier: 'tap',
	});
	expect(resolveBinding({ modifiers: ['meta'], keys: [] })).toEqual({
		tier: 'tap',
	});
});

test('isTierZeroChord names the permission-free tier boundary', () => {
	// A chord (one key plus a non-Fn modifier) is the only Tier-0 shape; Fn holds,
	// modifier-only holds, and bare keys all fall through to the Tier-1 tap.
	expect(
		isTierZeroChord({ modifiers: ['meta', 'shift'], keys: ['space'] }),
	).toBe(true);
	expect(isTierZeroChord({ modifiers: ['fn'], keys: ['space'] })).toBe(false);
	expect(isTierZeroChord({ modifiers: ['meta'], keys: [] })).toBe(false);
	expect(isTierZeroChord({ modifiers: [], keys: ['keyA'] })).toBe(false);
});

test('domCodeToKey maps physical codes to our Key space', () => {
	expect(domCodeToKey('KeyD')).toBe('keyD');
	expect(domCodeToKey('Digit1')).toBe('num1');
	expect(domCodeToKey('Space')).toBe('space');
	expect(domCodeToKey('Enter')).toBe('return');
	expect(domCodeToKey('Period')).toBe('dot');
	expect(domCodeToKey('BracketLeft')).toBe('leftBracket');
	expect(domCodeToKey('F5')).toBe('f5');
});

test('domCodeToKey rejects modifier codes and anything off the chord alphabet', () => {
	// Modifiers are read from the event's flags, not its code.
	expect(domCodeToKey('MetaLeft')).toBeNull();
	expect(domCodeToKey('ShiftRight')).toBeNull();
	expect(domCodeToKey('ControlLeft')).toBeNull();
	// Outside the alphabet keyBindingToAccelerator can spell.
	expect(domCodeToKey('Numpad1')).toBeNull();
	expect(domCodeToKey('Lang1')).toBeNull();
});

test('keyBindingToString emits only tokens parseManualBinding accepts', () => {
	// The canonical spelling drops the physical-key noun: keyA -> "a", dot -> ".",
	// upArrow -> "up". Modifiers keep their canonical names.
	expect(keyBindingToString({ modifiers: [], keys: ['keyA'] })).toBe('a');
	expect(keyBindingToString({ modifiers: [], keys: ['num1'] })).toBe('1');
	expect(keyBindingToString({ modifiers: [], keys: ['dot'] })).toBe('.');
	expect(keyBindingToString({ modifiers: [], keys: ['space'] })).toBe('space');
	expect(keyBindingToString({ modifiers: [], keys: ['upArrow'] })).toBe('up');
	expect(
		keyBindingToString({ modifiers: ['meta', 'shift'], keys: ['dot'] }),
	).toBe('meta+shift+.');
	expect(keyBindingToString({ modifiers: ['fn'], keys: [] })).toBe('fn');
});

test('parseManualBinding(keyBindingToString(b)) round-trips every binding shape', () => {
	const fixtures: KeyBinding[] = [
		// Bare keys (the in-app single-key defaults).
		{ modifiers: [], keys: ['keyC'] },
		{ modifiers: [], keys: ['space'] },
		{ modifiers: [], keys: ['f5'] },
		{ modifiers: [], keys: ['num0'] },
		// Chords.
		{ modifiers: ['ctrl'], keys: ['keyA'] },
		{ modifiers: ['meta', 'shift'], keys: ['dot'] },
		{ modifiers: ['ctrl', 'alt'], keys: ['delete'] },
		{ modifiers: ['alt'], keys: ['num1'] },
		// Fn (a Tier-1 global shape, still must round-trip through the grammar).
		{ modifiers: ['fn'], keys: ['space'] },
		// Modifier-only holds.
		{ modifiers: ['ctrl', 'meta'], keys: [] },
		{ modifiers: ['fn'], keys: [] },
		// Punctuation, arrows, named keys across the alphabet.
		{ modifiers: ['ctrl'], keys: ['slash'] },
		{ modifiers: ['ctrl'], keys: ['minus'] },
		{ modifiers: ['ctrl'], keys: ['equal'] },
		{ modifiers: ['ctrl'], keys: ['leftBracket'] },
		{ modifiers: ['ctrl'], keys: ['semiColon'] },
		{ modifiers: ['ctrl'], keys: ['quote'] },
		{ modifiers: ['ctrl'], keys: ['backQuote'] },
		{ modifiers: ['ctrl'], keys: ['backSlash'] },
		{ modifiers: ['meta'], keys: ['upArrow'] },
		{ modifiers: ['meta'], keys: ['pageDown'] },
		{ modifiers: [], keys: ['return'] },
		{ modifiers: [], keys: ['escape'] },
		{ modifiers: [], keys: ['backspace'] },
	];
	for (const binding of fixtures) {
		expect(parseManualBinding(keyBindingToString(binding))).toEqual(binding);
	}
});

test('domCodeToKey is the inverse of acceleratorKey for every chord key', () => {
	// Every key a chord can carry round-trips: Key -> accelerator code -> Key. This
	// is what guarantees a webview-captured code always lands on a bindable Key.
	const keys = [
		'keyA',
		'keyZ',
		'num0',
		'num9',
		'f1',
		'f12',
		'space',
		'return',
		'comma',
		'slash',
		'leftBracket',
		'semiColon',
	] as const;
	for (const key of keys) {
		const code = keyBindingToAccelerator({ modifiers: ['ctrl'], keys: [key] })
			?.split('+')
			.at(-1);
		expect(code).toBeDefined();
		expect(domCodeToKey(code as string)).toBe(key);
	}
});
