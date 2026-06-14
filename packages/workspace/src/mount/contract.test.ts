/**
 * Pins `validateMountNames`, the gate that runs before any mount opens.
 *
 * Mount names become `/list` manifest keys and daemon action paths
 * (`${mount}.${action}`) and, under the namespace-root layout, the names of
 * generated folders that are direct children of the Epicenter root. So the
 * pattern has to reject anything that would collide with a reserved sibling
 * (`.epicenter`, `epicenter.config.ts`), escape the root (`..`, `a/b`), or land
 * a dangerous object key (`__proto__`). These tests lock that in so a loosened
 * regex fails loudly here instead of in the daemon.
 */

import { describe, expect, test } from 'bun:test';
import { validateMountNames } from './contract.js';

describe('validateMountNames', () => {
	test('accepts plain alphanumeric and dash/underscore names', () => {
		expect(
			validateMountNames([
				'fuji',
				'honeycrisp',
				'tab-manager',
				'note_1',
				'A1',
				'0',
			]),
		).toBeNull();
	});

	test('accepts an empty list', () => {
		expect(validateMountNames([])).toBeNull();
	});

	// Each of these would collide with a reserved sibling, escape the Epicenter
	// root, or land a dangerous object key as a generated folder name.
	const invalidNames = [
		'.epicenter',
		'epicenter.config.ts',
		'..',
		'.',
		'a/b',
		'a\\b',
		'__proto__',
		'-leading',
		'_leading',
		'foo.bar',
		'has space',
		'',
	];
	for (const name of invalidNames) {
		test(`rejects ${JSON.stringify(name)} as invalid`, () => {
			expect(validateMountNames([name])).toEqual({
				mount: name,
				reason: 'invalid',
			});
		});
	}

	test('flags the first duplicate name', () => {
		expect(validateMountNames(['fuji', 'honeycrisp', 'fuji'])).toEqual({
			mount: 'fuji',
			reason: 'duplicate',
		});
	});

	test('reports a duplicate before an invalid name later in the list', () => {
		// Duplicate detection sweeps the whole list before any name-shape check,
		// so the repeated valid name wins over the trailing invalid one.
		expect(validateMountNames(['fuji', 'fuji', '__proto__'])).toEqual({
			mount: 'fuji',
			reason: 'duplicate',
		});
	});
});
