import type { CreateMutationResult } from '@tanstack/svelte-query';
import { Ok, type Result } from 'wellcrafted/result';
import { createResultMutation } from './query.js';

type IsExact<TActual, TExpected> = [TActual] extends [TExpected]
	? [TExpected] extends [TActual]
		? true
		: false
	: false;
type Expect<T extends true> = T;

type TestError = {
	name: 'TestError';
	message: string;
};

type TestInput = {
	id: string;
};

function createTypedMutation() {
	return createResultMutation(() => ({
		mutationFn: (_input: TestInput): Result<'saved', TestError> =>
			Ok('saved' as const),
		onError: (error) => {
			const typedError: TestError = error;
			void typedError;
		},
		onSuccess: (data) => {
			const typedData: 'saved' = data;
			void typedData;
		},
	}));
}

function createAsyncTypedMutation() {
	return createResultMutation(() => ({
		mutationFn: async (): Promise<Result<42, TestError>> => Ok(42 as const),
	}));
}

export type CreateResultMutationInfersInput = Expect<
	IsExact<
		ReturnType<typeof createTypedMutation>,
		CreateMutationResult<'saved', TestError, TestInput, unknown>
	>
>;

export type CreateResultMutationInfersPromiseResult = Expect<
	IsExact<
		ReturnType<typeof createAsyncTypedMutation>,
		CreateMutationResult<42, TestError, void, unknown>
	>
>;
