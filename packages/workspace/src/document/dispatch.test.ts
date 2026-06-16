/**
 * Tests for the live-node dispatch module.
 *
 * Covers the two pure pieces of dispatch:
 *
 *   - `runInboundDispatch`: recipient-side text-frame handler that runs
 *     the local action registry and emits a `dispatch_response`.
 *   - `interpretDispatchResult`: caller-side validation of relay
 *     `dispatch_result.result` payloads.
 *
 * The relay's `dispatch_request` / `dispatch_result` round trip is covered
 * in `packages/server/src/room/backends/cloudflare/durable-object.test.ts`. The caller-side transport in
 * `openCollaboration.dispatch` (pending map, response ceiling, abort,
 * disconnect sweep) is not yet unit-tested.
 */

import { describe, expect, test } from 'bun:test';
import { Err, Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { defineMutation, defineQuery } from '../shared/actions.js';
import {
	DispatchError,
	interpretDispatchResult,
	runInboundDispatch,
} from './dispatch.js';

// ════════════════════════════════════════════════════════════════════════════
// runInboundDispatch (recipient side)
// ════════════════════════════════════════════════════════════════════════════

describe('runInboundDispatch', () => {
	test('happy path: runs action and Ok-wraps the result', async () => {
		const actions = {
			noop_ping: defineQuery({ handler: () => 'pong' }),
		};
		const inbound = JSON.stringify({
			type: 'dispatch_inbound',
			id: 'i7',
			action: 'noop_ping',
			input: undefined,
		});

		const response = await runInboundDispatch({ rawFrame: inbound, actions });

		expect(response).not.toBeNull();
		const parsed = JSON.parse(response!);
		expect(parsed.type).toBe('dispatch_response');
		expect(parsed.id).toBe('i7');
		expect(parsed.result.data).toBe('pong');
	});

	test('unknown action: ActionNotFound response', async () => {
		const inbound = JSON.stringify({
			type: 'dispatch_inbound',
			id: 'i8',
			action: 'missing_action',
			input: undefined,
		});

		const response = await runInboundDispatch({
			rawFrame: inbound,
			actions: {},
		});

		const parsed = JSON.parse(response!);
		expect(parsed.result.error.name).toBe('ActionNotFound');
		expect(parsed.result.error.action).toBe('missing_action');
	});

	test('handler throws: ActionFailed with serialized cause string', async () => {
		const actions = {
			boom: defineMutation({
				handler: () => {
					throw new Error('handler exploded');
				},
			}),
		};
		const inbound = JSON.stringify({
			type: 'dispatch_inbound',
			id: 'i9',
			action: 'boom',
			input: undefined,
		});

		const response = await runInboundDispatch({ rawFrame: inbound, actions });
		const parsed = JSON.parse(response!);
		expect(parsed.result.error.name).toBe('ActionFailed');
		expect(parsed.result.error.action).toBe('boom');
		expect(typeof parsed.result.error.cause).toBe('string');
		expect(parsed.result.error.cause).toBe('handler exploded');
	});

	test('handler returns Err: ActionFailed with cause', async () => {
		const actions = {
			fail_err: defineMutation({
				handler: () => Err(new Error('domain error')),
			}),
		};
		const inbound = JSON.stringify({
			type: 'dispatch_inbound',
			id: 'i10',
			action: 'fail_err',
			input: undefined,
		});

		const response = await runInboundDispatch({ rawFrame: inbound, actions });
		const parsed = JSON.parse(response!);
		expect(parsed.result.error.name).toBe('ActionFailed');
		expect(parsed.result.error.cause).toBe('domain error');
	});

	test('malformed frame: returns null (do not tear down the socket)', async () => {
		expect(
			await runInboundDispatch({ rawFrame: '{not json', actions: {} }),
		).toBeNull();
		expect(
			await runInboundDispatch({
				rawFrame: JSON.stringify({ type: 'not_dispatch' }),
				actions: {},
			}),
		).toBeNull();
	});

	test('handler returns Ok directly: preserved as-is', async () => {
		const actions = {
			already_ok: defineQuery({ handler: () => Ok({ shape: 'preserved' }) }),
		};
		const inbound = JSON.stringify({
			type: 'dispatch_inbound',
			id: 'i11',
			action: 'already_ok',
			input: undefined,
		});
		const response = await runInboundDispatch({ rawFrame: inbound, actions });
		const parsed = JSON.parse(response!);
		expect(parsed.result.data).toEqual({ shape: 'preserved' });
	});
});

// ════════════════════════════════════════════════════════════════════════════
// interpretDispatchResult (caller side)
// ════════════════════════════════════════════════════════════════════════════

describe('interpretDispatchResult', () => {
	test('Ok body: unwraps the success payload', () => {
		const result = interpretDispatchResult(Ok({ closed: 2 }));
		const data = expectOk(result) as { closed: number };
		expect(data.closed).toBe(2);
	});

	test('Ok(null) body: success carrying null, not an error', () => {
		expect(expectOk(interpretDispatchResult(Ok(null)))).toBeNull();
	});

	test('body is not a Result: NetworkFailed', () => {
		const error = expectErr(interpretDispatchResult({ unexpected: true }));
		expect(error.name).toBe('NetworkFailed');
	});

	test('RecipientOffline: decoded from the Err body', () => {
		const error = expectErr(
			interpretDispatchResult(Err({ name: 'RecipientOffline', to: 'R_phone' })),
		);
		expect(error.name).toBe('RecipientOffline');
	});

	test('ActionNotFound: decoded with the action key', () => {
		const error = expectErr(
			interpretDispatchResult(
				Err({ name: 'ActionNotFound', action: 'tabs_close' }),
			),
		);
		expect(error.name).toBe('ActionNotFound');
		if (error.name !== 'ActionNotFound') throw new Error('unreachable');
		expect(error.action).toBe('tabs_close');
	});

	test('ActionFailed: decoded with the action key and cause', () => {
		const error = expectErr(
			interpretDispatchResult(
				Err({ name: 'ActionFailed', action: 'tabs_close', cause: 'boom' }),
			),
		);
		expect(error.name).toBe('ActionFailed');
		if (error.name !== 'ActionFailed') throw new Error('unreachable');
		expect(error.cause).toBe('boom');
	});

	test('unrecognized wire error: NetworkFailed', () => {
		const error = expectErr(interpretDispatchResult(Err({ name: 'Bogus' })));
		expect(error.name).toBe('NetworkFailed');
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Error factory hygiene
// ════════════════════════════════════════════════════════════════════════════

describe('DispatchError variant factory', () => {
	test('RecipientOffline includes the target id in the message', () => {
		const { error } = DispatchError.RecipientOffline({ to: 'R_phone' });
		expect(error).toMatchObject({ name: 'RecipientOffline', to: 'R_phone' });
		expect(error?.message).toBe('Recipient "R_phone" is offline');
	});
});
