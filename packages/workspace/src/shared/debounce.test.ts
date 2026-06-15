import { describe, expect, test } from 'bun:test';

import { debounce } from './debounce.js';

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('debounce', () => {
	test('runs once after the quiet window, with the last call args', async () => {
		const calls: string[] = [];
		const fn = debounce((value: string) => calls.push(value), 20);

		fn('a');
		fn('b');
		fn('c');
		expect(calls).toEqual([]);

		await tick(40);
		expect(calls).toEqual(['c']);
	});

	test('each call restarts the timer', async () => {
		let runs = 0;
		const fn = debounce(() => runs++, 30);

		fn();
		await tick(20);
		fn(); // restarts: the first call must not have fired yet
		expect(runs).toBe(0);

		await tick(50);
		expect(runs).toBe(1);
	});

	test('cancel() drops a pending run', async () => {
		let runs = 0;
		const fn = debounce(() => runs++, 20);

		fn();
		fn.cancel();
		await tick(40);
		expect(runs).toBe(0);
	});

	test('cancel() is a no-op when nothing is pending', () => {
		const fn = debounce(() => {}, 20);
		expect(() => fn.cancel()).not.toThrow();
	});

	test('a run after cancel() still fires', async () => {
		let runs = 0;
		const fn = debounce(() => runs++, 20);

		fn();
		fn.cancel();
		fn();
		await tick(40);
		expect(runs).toBe(1);
	});
});
