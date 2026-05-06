/**
 * Format Output Tests
 *
 * Exercises the public `output` function: JSON for single values, JSONL for
 * arrays, pretty-on-TTY / compact-on-pipe. Captures stdout via console.log.
 */
import { describe, expect, test } from 'bun:test';
import { output } from './format-output.js';

function captureStdout(fn: () => void): string {
	const original = console.log;
	const lines: string[] = [];
	console.log = (...args: unknown[]) =>
		lines.push(args.map(String).join(' '));
	try {
		fn();
	} finally {
		console.log = original;
	}
	return lines.join('\n');
}

function withTTY<T>(isTTY: boolean, fn: () => T): T {
	const original = process.stdout.isTTY;
	Object.defineProperty(process.stdout, 'isTTY', {
		value: isTTY,
		writable: true,
		configurable: true,
	});
	try {
		return fn();
	} finally {
		Object.defineProperty(process.stdout, 'isTTY', {
			value: original,
			writable: true,
			configurable: true,
		});
	}
}

describe('output (json)', () => {
	test('pretty-prints when TTY', () => {
		const result = withTTY(true, () =>
			captureStdout(() => output({ name: 'test', value: 42 })),
		);
		expect(result).toBe('{\n  "name": "test",\n  "value": 42\n}');
	});

	test('compacts when not TTY', () => {
		const result = withTTY(false, () =>
			captureStdout(() => output({ name: 'test', value: 42 })),
		);
		expect(result).toBe('{"name":"test","value":42}');
	});

	test('compacts when format is jsonl regardless of TTY', () => {
		const result = withTTY(true, () =>
			captureStdout(() => output([{ name: 'test' }], { format: 'jsonl' })),
		);
		expect(result).toBe('{"name":"test"}');
	});
});

describe('output (jsonl)', () => {
	test('outputs one object per line', () => {
		const values = [
			{ id: 1, name: 'first' },
			{ id: 2, name: 'second' },
			{ id: 3, name: 'third' },
		];
		const result = captureStdout(() => output(values, { format: 'jsonl' }));
		expect(result).toBe(
			'{"id":1,"name":"first"}\n{"id":2,"name":"second"}\n{"id":3,"name":"third"}',
		);
	});

	test('handles empty array', () => {
		const result = captureStdout(() => output([], { format: 'jsonl' }));
		expect(result).toBe('');
	});

	test('handles single item', () => {
		const result = captureStdout(() =>
			output([{ value: 'single' }], { format: 'jsonl' }),
		);
		expect(result).toBe('{"value":"single"}');
	});

	test('serializes mixed JSON-compatible values as one JSON value per line', () => {
		const values = [{ a: 1 }, 'string', 42, null, [1, 2, 3]];
		const result = captureStdout(() => output(values, { format: 'jsonl' }));
		expect(result).toBe('{"a":1}\n"string"\n42\nnull\n[1,2,3]');
	});

	test('throws when format is jsonl but value is not array', () => {
		expect(() => output({ notAnArray: true }, { format: 'jsonl' })).toThrow(
			'JSONL format requires an array value',
		);
	});
});
