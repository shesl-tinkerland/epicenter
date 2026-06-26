/**
 * `resolveDataDir` unit tests.
 *
 * Pins the invariant the self-host token relied on: the rooms dir and the
 * instance-token dir come from ONE resolver with ONE default, so they can never
 * diverge (the prior bug minted the token into the cwd via `?? '.'` while rooms
 * persisted under `?? './.data/rooms'`, so a container that mounted only the
 * rooms volume silently lost the token on restart).
 */

import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { resolveDataDir } from './start-bun-server.js';

test('defaults to ./.data/rooms, resolved absolute', () => {
	expect(resolveDataDir({})).toBe(resolve('./.data/rooms'));
});

test('DATA_DIR overrides the default and is resolved absolute', () => {
	expect(resolveDataDir({ DATA_DIR: '/srv/epicenter' })).toBe('/srv/epicenter');
	expect(resolveDataDir({ DATA_DIR: './custom' })).toBe(resolve('./custom'));
});
