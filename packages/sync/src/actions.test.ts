/**
 * Tests for the action system primitives in `actions.ts`.
 *
 * Currently focused on `invokeAction`: the canonical "given an action
 * and an input, return Promise<Result<T, RpcError>>" util used by every
 * consumer that doesn't know the handler shape ahead of time (AI bridge,
 * CLI dispatch, inbound RPC handler).
 */

import { describe, expect, test } from 'bun:test';
import Type from 'typebox';
import { Err, Ok } from 'wellcrafted/result';
import { defineMutation, defineQuery, invokeAction } from './actions';
import { isRpcError } from './rpc-errors';

// ------------------------------------------------------------
// invokeAction
// ------------------------------------------------------------

describe('invokeAction', () => {
	describe('return shape normalization', () => {
		test('Ok-wraps a raw return value from a sync handler', async () => {
			const action = defineMutation({
				handler: () => ({ count: 7 }),
			});
			const result = await invokeAction<{ count: number }>(action);
			expect(result.error).toBeNull();
			expect(result.data).toEqual({ count: 7 });
		});

		test('Ok-wraps a raw return value from an async handler', async () => {
			const action = defineMutation({
				handler: async () => ({ count: 11 }),
			});
			const result = await invokeAction<{ count: number }>(action);
			expect(result.error).toBeNull();
			expect(result.data).toEqual({ count: 11 });
		});

		test('passes through an Ok from a Result-returning handler unchanged', async () => {
			const action = defineMutation({
				handler: () => Ok({ ok: true }),
			});
			const result = await invokeAction<{ ok: boolean }>(action);
			expect(result.error).toBeNull();
			expect(result.data).toEqual({ ok: true });
		});

		test('passes through an Err from a Result-returning handler unchanged', async () => {
			const customError = { name: 'CustomFailure', message: 'bad' };
			const action = defineMutation({
				handler: () =>
					Err(customError) as unknown as ReturnType<typeof Ok>,
			});
			const result = await invokeAction(action);
			expect(result.data).toBeNull();
			// The handler's typed Err leaks through invokeAction's
			// declared `RpcError` error type: that's the cost of generic
			// normalization. Cast to compare structurally.
			expect(result.error as unknown).toEqual(customError);
		});

		test('isResult discrimination is structural: any {data,error}-shaped value passes through unchanged', async () => {
			// wellcrafted's isResult is structural: any object with both
			// `data` and `error` properties is treated as a Result. There
			// is no brand. So a {data,error}-shaped return passes through
			// to the caller as-is: invokeAction does NOT double-wrap.
			const lookalike = { data: 'fake', error: null };
			const action = defineMutation({
				handler: () => lookalike as unknown as ReturnType<typeof Ok>,
			});
			const result = await invokeAction<string>(action);
			expect(result.error).toBeNull();
			expect(result.data).toBe('fake');
		});
	});

	describe('error handling', () => {
		test('catches a thrown Error and returns Err(ActionFailed) with cause', async () => {
			const cause = new Error('handler exploded');
			const action = defineMutation({
				handler: () => {
					throw cause;
				},
			});
			const result = await invokeAction(action);
			expect(result.data).toBeNull();
			expect(isRpcError(result.error)).toBe(true);
			expect(result.error?.name).toBe('ActionFailed');
			if (result.error?.name === 'ActionFailed') {
				expect(result.error.cause).toBe(cause);
			}
		});

		test('catches an async rejection and returns Err(ActionFailed) with cause', async () => {
			const cause = new Error('async boom');
			const action = defineMutation({
				handler: async () => {
					throw cause;
				},
			});
			const result = await invokeAction(action);
			expect(result.data).toBeNull();
			expect(result.error?.name).toBe('ActionFailed');
			if (result.error?.name === 'ActionFailed') {
				expect(result.error.cause).toBe(cause);
			}
		});

		test('catches a thrown non-Error value and preserves it as cause', async () => {
			const action = defineMutation({
				handler: () => {
					throw 'string-throw';
				},
			});
			const result = await invokeAction(action);
			expect(result.error?.name).toBe('ActionFailed');
			if (result.error?.name === 'ActionFailed') {
				expect(result.error.cause).toBe('string-throw');
			}
		});
	});

	describe('input handling', () => {
		test('does not pass input arg when action.input is undefined', async () => {
			const seenArgs: unknown[] = [];
			const action = defineMutation({
				handler: (...args: unknown[]) => {
					seenArgs.push(args);
					return null;
				},
			});
			await invokeAction(action, { ignored: true });
			expect(seenArgs).toEqual([[]]);
		});

		test('passes input through when action.input is defined', async () => {
			const inputSchema = Type.Object({ x: Type.Number() });
			const seenInputs: unknown[] = [];
			const action = defineMutation({
				input: inputSchema,
				handler: (input) => {
					seenInputs.push(input);
					return input.x * 2;
				},
			});
			const result = await invokeAction<number>(action, { x: 21 });
			expect(seenInputs).toEqual([{ x: 21 }]);
			expect(result.data).toBe(42);
		});
	});

	describe('errorLabel', () => {
		test('uses provided errorLabel on Err(ActionFailed).action', async () => {
			const action = defineMutation({
				title: 'Title Override',
				handler: () => {
					throw new Error('x');
				},
			});
			const result = await invokeAction(action, undefined, 'tabs.close');
			expect(result.error?.name).toBe('ActionFailed');
			if (result.error?.name === 'ActionFailed') {
				expect(result.error.action).toBe('tabs.close');
			}
		});

		test('falls back to action.title when no errorLabel provided', async () => {
			const action = defineMutation({
				title: 'My Action',
				handler: () => {
					throw new Error('x');
				},
			});
			const result = await invokeAction(action);
			if (result.error?.name === 'ActionFailed') {
				expect(result.error.action).toBe('My Action');
			}
		});

		test('falls back to "anonymous" when neither errorLabel nor title is set', async () => {
			const action = defineMutation({
				handler: () => {
					throw new Error('x');
				},
			});
			const result = await invokeAction(action);
			if (result.error?.name === 'ActionFailed') {
				expect(result.error.action).toBe('anonymous');
			}
		});
	});

	describe('query and mutation parity', () => {
		test('queries normalize identically to mutations', async () => {
			const query = defineQuery({
				handler: () => ({ kind: 'query' as const }),
			});
			const mutation = defineMutation({
				handler: () => ({ kind: 'mutation' as const }),
			});
			const queryResult = await invokeAction<{ kind: 'query' }>(query);
			const mutationResult = await invokeAction<{ kind: 'mutation' }>(
				mutation,
			);
			expect(queryResult.data).toEqual({ kind: 'query' });
			expect(mutationResult.data).toEqual({ kind: 'mutation' });
		});
	});
});
