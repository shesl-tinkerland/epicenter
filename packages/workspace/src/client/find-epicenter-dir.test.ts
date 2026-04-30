/**
 * Unit tests for `findEpicenterDir`. Uses real tmpdirs because the helper
 * touches the filesystem; mocking `existsSync` would be more fragile than
 * a few `mkdirSync` / `writeFileSync` calls.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProjectDir } from '../shared/types.js';
import { findEpicenterDir } from './find-epicenter-dir.js';

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'find-epicenter-'));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe('findEpicenterDir', () => {
	test('finds via epicenter.config.ts marker', () => {
		writeFileSync(join(root, 'epicenter.config.ts'), '');
		// Cast on the expected side: after the marker is written, `root`
		// genuinely is a project root, so claiming the brand is honest.
		expect(findEpicenterDir(root)).toBe(root as ProjectDir);
	});

	test('finds via .epicenter directory marker', () => {
		mkdirSync(join(root, '.epicenter'));
		expect(findEpicenterDir(root)).toBe(root as ProjectDir);
	});

	test('walks up from a nested subdirectory', () => {
		writeFileSync(join(root, 'epicenter.config.ts'), '');
		const nested = join(root, 'a', 'b', 'c');
		mkdirSync(nested, { recursive: true });
		expect(findEpicenterDir(nested)).toBe(root as ProjectDir);
	});

	test('throws if no marker is found', () => {
		expect(() => findEpicenterDir(root)).toThrow(
			/no epicenter\.config\.ts or \.epicenter\/ directory/,
		);
	});
});
