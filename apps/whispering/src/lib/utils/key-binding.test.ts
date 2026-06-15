import { expect, test } from 'bun:test';
import { type BindingLike, bindingsOverlap } from './key-binding';

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
	const ptt: BindingLike = { modifiers: ['fn'], keys: [] };
	const toggle: BindingLike = { modifiers: ['meta', 'shift'], keys: ['space'] };
	const cancel: BindingLike = { modifiers: ['meta'], keys: ['dot'] };
	expect(bindingsOverlap(ptt, toggle)).toBe(false);
	expect(bindingsOverlap(ptt, cancel)).toBe(false);
	expect(bindingsOverlap(toggle, cancel)).toBe(false);
});

test('sibling chords sharing a modifier but differing in key do not overlap', () => {
	// Ctrl+Shift+Space and Ctrl+Shift+. (Windows toggle vs cancel).
	expect(
		bindingsOverlap(
			{ modifiers: ['ctrl', 'shift'], keys: ['space'] },
			{ modifiers: ['ctrl', 'shift'], keys: ['dot'] },
		),
	).toBe(false);
});
