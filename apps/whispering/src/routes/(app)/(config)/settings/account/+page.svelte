<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Field from '@epicenter/ui/field';
	import { toastOnError } from '@epicenter/ui/sonner';
	import { createMutation, createQuery } from '@tanstack/svelte-query';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import LogOut from '@lucide/svelte/icons/log-out';
	import { auth } from '#platform/auth';

	type AccountProfile = { user: { id: string; email: string } };

	const isSignedIn = $derived(auth.state.status === 'signed-in');
	const profileCacheKey = $derived(
		auth.state.status === 'signed-out' ? null : auth.state.ownerId,
	);

	const profile = createQuery(() => ({
		queryKey: ['account-profile', profileCacheKey],
		queryFn: async (): Promise<AccountProfile> => {
			const response = await auth.fetch('/api/session');
			if (!response.ok) {
				throw new Error(`Failed to load account (${response.status}).`);
			}
			return (await response.json()) as AccountProfile;
		},
		enabled: auth.state.status !== 'signed-out',
		staleTime: Infinity,
	}));

	const email = $derived(
		profile.data?.user.email ?? (profile.error ? 'Offline' : 'Loading...'),
	);

	const startSignIn = createMutation(() => ({
		mutationKey: ['account', 'startSignIn'],
		mutationFn: () => auth.startSignIn(),
	}));

	const signOut = createMutation(() => ({
		mutationKey: ['account', 'signOut'],
		mutationFn: () => auth.signOut(),
		onError: (error) => toastOnError(error, 'Failed to sign out'),
	}));
</script>

<svelte:head> <title>Account - Whispering</title> </svelte:head>

<Field.Set>
	<Field.Legend>Account</Field.Legend>
	<Field.Description>
		Sign in to your Epicenter account. Whispering works fully offline without
		one; your account is what device sync will use.
	</Field.Description>
	<Field.Separator />

	<Field.Group>
		{#if isSignedIn}
			<Field.Field orientation="horizontal">
				<Field.Content>
					<Field.Label>Signed in</Field.Label>
					<Field.Description>{email}</Field.Description>
				</Field.Content>
				<Button
					variant="outline"
					onclick={() => signOut.mutate()}
					disabled={signOut.isPending}
				>
					{#if signOut.isPending}
						<LoaderCircle class="size-4 animate-spin" />
					{:else}
						<LogOut class="size-4" />
					{/if}
					Sign out
				</Button>
			</Field.Field>
		{:else}
			<Field.Field>
				{#if startSignIn.error}
					<Field.Description class="text-destructive">
						{startSignIn.error.message}
					</Field.Description>
				{/if}
				<Button
					class="w-full sm:w-auto sm:self-start"
					onclick={() => startSignIn.mutate()}
					disabled={startSignIn.isPending}
				>
					{#if startSignIn.isPending}
						<LoaderCircle class="size-4 animate-spin" />
						Signing in...
					{:else if auth.state.status === 'reauth-required'}
						Reconnect
					{:else}
						Sign in with Epicenter
					{/if}
				</Button>
			</Field.Field>
		{/if}
	</Field.Group>

	<Field.Separator />

	<Field.Set>
		<Field.Legend variant="label">Sync</Field.Legend>
		<Field.Description>
			Device sync is not turned on yet. Sign-in is ready; syncing your
			recordings across devices ships next.
		</Field.Description>
	</Field.Set>
</Field.Set>
