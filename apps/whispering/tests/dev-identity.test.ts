import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guards the macOS dev Accessibility identity against silent regression.
 *
 * The dev grant only survives rebuilds while three things agree on one
 * identifier and dev stays distinct from production. If any of these drift, dev
 * Accessibility quietly breaks again, so assert them instead of trusting code
 * review to notice a one-character edit.
 */
const SRC_TAURI = join(import.meta.dir, '..', 'src-tauri');
const DEV_IDENTIFIER = 'so.epicenter.whispering.dev';

const read = (name: string) => readFileSync(join(SRC_TAURI, name), 'utf8');
const json = (name: string) => JSON.parse(read(name));

describe('dev macOS identity', () => {
	test('dev config carries the distinct dev identity', () => {
		const dev = json('tauri.dev.conf.json');
		expect(dev.identifier).toBe(DEV_IDENTIFIER);
		expect(dev.productName).toBe('Whispering Dev');
	});

	test('production identity is untouched', () => {
		const prod = json('tauri.conf.json');
		expect(prod.identifier).toBe('so.epicenter.whispering');
		expect(prod.productName).toBe('Whispering');
	});

	test('the codesign runner signs with the same dev identifier', () => {
		const runner = read('scripts/dev-codesign-runner.sh');
		expect(runner).toContain(`DEV_IDENTIFIER="${DEV_IDENTIFIER}"`);
	});

	test('the macOS dev config wires in the codesign runner', () => {
		const macos = json('tauri.dev.macos.conf.json');
		expect(macos.build.runner.cmd).toBe('./scripts/dev-codesign-runner.sh');
	});
});
