/**
 * Tests for `resolveDaemonNodeId`, the daemon's durable per-install identity.
 *
 * The invariants that matter for the trusted-relay identity model:
 * - generated once and persisted under `.epicenter/node.json`
 * - stable across reopen (a restart keeps the same node)
 * - distinct per Epicenter root (two folders of the same app are two nodes)
 * - never derived from the path or the mount name (so two machines never collide)
 * - a corrupt state file self-heals into a fresh id
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveDaemonNodeId } from './daemon-node-id.js';

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'daemon-node-id-'));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe('resolveDaemonNodeId', () => {
	test('generates a 16-char id and persists it to .epicenter/node.json', () => {
		const id = resolveDaemonNodeId(root);
		expect(id).toMatch(/^[a-z0-9]{16}$/);
		const persisted = JSON.parse(
			readFileSync(join(root, '.epicenter', 'node.json'), 'utf8'),
		);
		expect(persisted['epicenter.node.id']).toBe(id);
	});

	test('is idempotent across calls (a restart keeps the same node)', () => {
		const first = resolveDaemonNodeId(root);
		const second = resolveDaemonNodeId(root);
		expect(second).toBe(first);
	});

	test('gives two roots distinct ids', () => {
		const other = mkdtempSync(join(tmpdir(), 'daemon-node-id-'));
		try {
			expect(resolveDaemonNodeId(root)).not.toBe(resolveDaemonNodeId(other));
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});

	test('self-heals a corrupt state file into a fresh id', () => {
		const file = join(root, '.epicenter', 'node.json');
		mkdirSync(join(root, '.epicenter'), { recursive: true });
		writeFileSync(file, 'not json', { mode: 0o600 });
		const id = resolveDaemonNodeId(root);
		expect(id).toMatch(/^[a-z0-9]{16}$/);
		expect(resolveDaemonNodeId(root)).toBe(id);
	});
});
