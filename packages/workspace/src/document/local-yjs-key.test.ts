import { describe, expect, test } from 'bun:test';
import { createOwnedYjsKey } from './local-yjs-key.js';

describe('createOwnedYjsKey', () => {
	test('uses the owner-scoped local Yjs key shape', () => {
		expect(createOwnedYjsKey('user-123', 'epicenter.fuji')).toBe(
			'epicenter.subject.user-123.yjs.epicenter.fuji',
		);
	});

	test('different subjects produce different local keys for the same Y.Doc', () => {
		expect(createOwnedYjsKey('user-a', 'epicenter.fuji')).not.toBe(
			createOwnedYjsKey('user-b', 'epicenter.fuji'),
		);
	});

	test('different Y.Doc GUIDs produce different local keys for the same subject', () => {
		expect(createOwnedYjsKey('user-a', 'epicenter.fuji')).not.toBe(
			createOwnedYjsKey('user-a', 'epicenter.honeycrisp'),
		);
	});
});
