import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { composeSinks, createLogger } from 'wellcrafted/logger';
import { jsonlFileSink } from './jsonl-sink.js';

const TestError = defineErrors({
	Boom: ({ cause }: { cause: unknown }) => ({
		message: `boom: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

const tempPaths: string[] = [];
const mkTempPath = (suffix: string) => {
	const p = join(
		tmpdir(),
		`jsonl-sink-${Date.now()}-${Math.random().toString(36).slice(2)}-${suffix}.jsonl`,
	);
	tempPaths.push(p);
	return p;
};

afterEach(async () => {
	while (tempPaths.length) {
		const p = tempPaths.pop() as string;
		await rm(p, { force: true }).catch(() => {});
	}
});

describe('jsonlFileSink', () => {
	test('writes one JSON object per line and flushes on asyncDispose', async () => {
		const path = mkTempPath('basic');
		{
			await using sink = jsonlFileSink(path);
			const log = createLogger('src', sink);
			log.info('first', { a: 1 });
			log.warn(TestError.Boom({ cause: new Error('kaboom') }));
		}
		const contents = await readFile(path, 'utf8');
		const lines = contents.trimEnd().split('\n');
		expect(lines).toHaveLength(2);
		const first = JSON.parse(lines[0] as string);
		expect(first.level).toBe('info');
		expect(first.source).toBe('src');
		expect(first.data).toEqual({ a: 1 });
		expect(typeof first.ts).toBe('string');
		expect(new Date(first.ts).toString()).not.toBe('Invalid Date');
		const second = JSON.parse(lines[1] as string);
		expect(second.level).toBe('warn');
		expect(second.data.name).toBe('Boom');
		expect(second.data.cause).toMatchObject({ name: 'Error', message: 'kaboom' });
	});

	test('auto-creates parent directory', async () => {
		const nested = join(
			tmpdir(),
			`jsonl-nested-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			'deep',
			'log.jsonl',
		);
		tempPaths.push(nested);
		{
			await using sink = jsonlFileSink(nested);
			const log = createLogger('s', sink);
			log.info('hello');
		}
		const text = await readFile(nested, 'utf8');
		expect(text).toContain('hello');
	});

	test('composeSinks forwards disposal through to file sink', async () => {
		const path = mkTempPath('composed');
		{
			await using file = jsonlFileSink(path);
			const composed = composeSinks(file);
			const log = createLogger('s', composed);
			log.info('via composed');
			await composed[Symbol.asyncDispose]?.();
		}
		const text = await readFile(path, 'utf8');
		expect(text).toContain('via composed');
	});
});
