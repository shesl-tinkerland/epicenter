import {
	type Accessor,
	type CreateMutationOptions,
	type CreateMutationResult,
	createMutation,
	type MutationFunctionContext,
	type QueryClient,
} from '@tanstack/svelte-query';
import {
	type Result,
	type UnwrapErr,
	type UnwrapOk,
	unwrap,
} from 'wellcrafted/result';

type MaybePromise<T> = T | Promise<T>;

/**
 * The exact shape a Result-aware mutation function must return.
 *
 * This is intentionally local to the adapter. Callers should name the operation
 * itself, not the intermediate Result extraction type.
 */
type ResultMutationFnReturn = MaybePromise<Result<unknown, unknown>>;

type MutationData<TMutationFnReturn extends ResultMutationFnReturn> = UnwrapOk<
	Awaited<TMutationFnReturn>
>;
type MutationError<TMutationFnReturn extends ResultMutationFnReturn> =
	UnwrapErr<Awaited<TMutationFnReturn>>;

/**
 * TanStack mutation options after translating the Result payload into
 * TanStack's data and error channels.
 *
 * The public API stays on `createResultMutation`. Keeping this type private
 * avoids teaching callers a second options name for the same component-local
 * mutation shape.
 */
type ResultMutationOptions<
	TMutationFnReturn extends ResultMutationFnReturn,
	TVariables = void,
	TOnMutateResult = unknown,
> = Omit<
	CreateMutationOptions<
		MutationData<TMutationFnReturn>,
		MutationError<TMutationFnReturn>,
		TVariables,
		TOnMutateResult
	>,
	'mutationFn'
> & {
	mutationFn: (
		variables: TVariables,
		context: MutationFunctionContext,
	) => TMutationFnReturn;
};

/**
 * Creates a Svelte TanStack mutation for operations that already return a
 * `wellcrafted/result`.
 *
 * Use this at component edges when a button or form needs TanStack lifecycle
 * state, but the operation should stay as a focused Result-returning function.
 * `Ok(data)` becomes `mutation.data`; `Err(error)` becomes `mutation.error`, so
 * lifecycle callbacks and template reads preserve the operation's own success
 * and error types.
 *
 * The operation itself still returns a Result. This adapter unwraps at the
 * TanStack boundary because TanStack records mutation errors from thrown values.
 *
 * Promote the operation to a shared `defineMutation` only when it needs a stable
 * mutation key, shared invalidation, optimistic updates, or multiple consumers.
 *
 * @example
 * ```svelte
 * <script lang="ts">
 * 	const startSignIn = createResultMutation(() => ({
 * 		mutationFn: () => auth.startSignIn(),
 * 	}));
 *
 * </script>
 *
 * {#if startSignIn.error}
 * 	<p>{startSignIn.error.message}</p>
 * {/if}
 *
 * <Button onclick={() => startSignIn.mutate()} disabled={startSignIn.isPending}>
 * 	{startSignIn.isPending ? 'Signing in...' : 'Sign in'}
 * </Button>
 * ```
 */
export function createResultMutation<
	TMutationFnReturn extends ResultMutationFnReturn,
	TVariables = void,
	TOnMutateResult = unknown,
>(
	options: Accessor<
		ResultMutationOptions<TMutationFnReturn, TVariables, TOnMutateResult>
	>,
	queryClient?: Accessor<QueryClient>,
): CreateMutationResult<
	MutationData<TMutationFnReturn>,
	MutationError<TMutationFnReturn>,
	TVariables,
	TOnMutateResult
> {
	return createMutation(() => {
		const current = options();

		return {
			...current,
			mutationFn: async (
				variables: TVariables,
				context: MutationFunctionContext,
			) => {
				const result = await current.mutationFn(variables, context);
				return unwrap(result) as MutationData<TMutationFnReturn>;
			},
		};
	}, queryClient);
}
