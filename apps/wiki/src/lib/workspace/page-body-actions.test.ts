/**
 * The page body write actions, in isolation from the vault/projection.
 *
 * `pages_set_body` (whole rewrite) and `pages_patch_body` (anchored str_replace)
 * are the agent-path write surface from
 * `specs/20260603T164627-agents-read-projection-write-actions.md`: an agent reads
 * the read-only markdown projection, then mutates only through these actions.
 * These tests touch only `createWiki` (isomorphic), never the markdown vault, so
 * they exercise the actions without the filesystem materializer.
 */

import { expect, test } from 'bun:test';
import { createWiki } from './index';

test('pages_set_body overwrites the body and returns the updated page', () => {
	const wiki = createWiki();
	try {
		const { id } = wiki.actions.pages_create({ title: 'Draft', body: 'first' });

		const set = wiki.actions.pages_set_body({ id, body: 'second' });
		expect(set.error).toBeNull();
		expect(set.data!.body).toBe('second');
		// Read-your-writes: the store reflects it without re-reading the file.
		expect(wiki.actions.pages_get({ id }).data!.body).toBe('second');
	} finally {
		wiki[Symbol.dispose]();
	}
});

test('pages_patch_body splices a unique anchor; rejects missing and ambiguous ones', () => {
	const wiki = createWiki();
	try {
		const { id } = wiki.actions.pages_create({
			title: 'Draft',
			body: 'alpha beta gamma',
		});

		// Surgical replace of a single unique anchor.
		const patched = wiki.actions.pages_patch_body({
			id,
			old: 'beta',
			new: 'BETA',
		});
		expect(patched.error).toBeNull();
		expect(patched.data!.body).toBe('alpha BETA gamma');

		// A missing anchor fails loud and leaves the body untouched.
		const missing = wiki.actions.pages_patch_body({ id, old: 'delta', new: 'x' });
		expect(missing.error?.name).toBe('AnchorNotFound');
		expect(wiki.actions.pages_get({ id }).data!.body).toBe('alpha BETA gamma');

		// An ambiguous anchor (two occurrences) fails loud and leaves it untouched.
		wiki.actions.pages_set_body({ id, body: 'one one' });
		const ambiguous = wiki.actions.pages_patch_body({ id, old: 'one', new: 'two' });
		expect(ambiguous.error?.name).toBe('AnchorAmbiguous');
		expect(wiki.actions.pages_get({ id }).data!.body).toBe('one one');
	} finally {
		wiki[Symbol.dispose]();
	}
});

test('pages_patch_body uses a literal splice, not String.replace ($ is not special)', () => {
	const wiki = createWiki();
	try {
		const { id } = wiki.actions.pages_create({
			title: 'Draft',
			body: 'a TOKEN b',
		});
		// `$&` in a String.replace replacement would re-insert the match; a literal
		// splice writes it verbatim.
		const patched = wiki.actions.pages_patch_body({
			id,
			old: 'TOKEN',
			new: '$& and $1',
		});
		expect(patched.data!.body).toBe('a $& and $1 b');
	} finally {
		wiki[Symbol.dispose]();
	}
});

test('pages_set_body rejects an unknown page id', () => {
	const wiki = createWiki();
	try {
		const result = wiki.actions.pages_set_body({ id: 'nope', body: 'x' });
		expect(result.error?.name).toBe('PageNotFound');
	} finally {
		wiki[Symbol.dispose]();
	}
});
