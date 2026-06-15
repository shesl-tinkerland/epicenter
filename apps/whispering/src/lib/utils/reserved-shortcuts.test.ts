import { expect, test } from 'bun:test';
import { validateGlobalBinding } from './reserved-shortcuts';

test('an empty binding is treated as unset and passes', () => {
	expect(validateGlobalBinding({ modifiers: [], keys: [] })).toBeNull();
});

test('shipped defaults pass the policy', () => {
	// macOS defaults.
	expect(validateGlobalBinding({ modifiers: ['fn'], keys: [] })).toBeNull();
	expect(
		validateGlobalBinding({ modifiers: ['meta', 'shift'], keys: ['space'] }),
	).toBeNull();
	expect(
		validateGlobalBinding({ modifiers: ['meta'], keys: ['dot'] }),
	).toBeNull();
	// Windows/Linux defaults.
	expect(
		validateGlobalBinding({ modifiers: ['ctrl', 'meta'], keys: [] }),
	).toBeNull();
	expect(
		validateGlobalBinding({ modifiers: ['ctrl', 'shift'], keys: ['space'] }),
	).toBeNull();
});

test('a reserved combo is refused with its label', () => {
	const reason = validateGlobalBinding({ modifiers: ['meta'], keys: ['keyR'] });
	expect(reason).toContain('Reload');
});

test('primary expands to control as well as command', () => {
	// Ctrl+R must be blocked too, not just Cmd+R, from the single `primary` entry.
	expect(
		validateGlobalBinding({ modifiers: ['ctrl'], keys: ['keyR'] }),
	).toContain('Reload');
});

test('literal meta+space (Spotlight) is reserved but meta+shift+space is not', () => {
	expect(
		validateGlobalBinding({ modifiers: ['meta'], keys: ['space'] }),
	).toContain('System search');
	// The toggle default adds Shift, a different set, so it stays allowed.
	expect(
		validateGlobalBinding({ modifiers: ['meta', 'shift'], keys: ['space'] }),
	).toBeNull();
});

test('a bare key with no modifier is refused', () => {
	const reason = validateGlobalBinding({ modifiers: [], keys: ['space'] });
	expect(reason).toContain('modifier');
});

test('a superset of a reserved chord is allowed (exact-set matching)', () => {
	// Ctrl+Win+Space is not the literal meta+space Spotlight chord.
	expect(
		validateGlobalBinding({ modifiers: ['ctrl', 'meta'], keys: ['space'] }),
	).toBeNull();
});
