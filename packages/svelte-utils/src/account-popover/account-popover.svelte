<script lang="ts">
	import type { AuthClient } from '@epicenter/auth';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Popover from '@epicenter/ui/popover';
	import { toast, toastOnError } from '@epicenter/ui/sonner';
	import type { Collaboration, SyncStatus } from '@epicenter/workspace';
	import Cloud from '@lucide/svelte/icons/cloud';
	import CloudOff from '@lucide/svelte/icons/cloud-off';
	import DatabaseZap from '@lucide/svelte/icons/database-zap';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import LogOut from '@lucide/svelte/icons/log-out';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import User from '@lucide/svelte/icons/user';
	import { createQuery, QueryClient } from '@tanstack/svelte-query';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { createResultMutation } from '../query.js';

	const accountProfileQueryClient = new QueryClient({
		defaultOptions: {
			queries: {
				refetchOnWindowFocus: false,
			},
		},
	});

	type AccountProfile = {
		user: {
			id: string;
			email: string;
		};
	};

	/**
	 * Shared account popover.
	 *
	 * Renders auth identity and sign-out. When a collaboration runtime is
	 * present, it also renders sync status from the three fields it actually
	 * needs (`status`, `onStatusChange`, `reconnect`) rather than the full
	 * `Collaboration` value, so RPC, peers, and presence do not leak into the
	 * account UI surface.
	 *
	 * Mount once in each app's root layout alongside `<ConfirmationDialog />`.
	 */
	type AccountPopoverProps = {
		/** The auth client from `createOAuthAppAuth()`. */
		auth: AuthClient;
		/**
		 * Sync surface slice from the binding's optional `collaboration`.
		 * Omit it until Cloud sync is attached.
		 */
		collaboration?: Pick<
			Collaboration,
			'status' | 'onStatusChange' | 'reconnect'
		>;
		/** Noun describing what gets synced, e.g. "tabs" or "notes". */
		syncNoun: string;
		/**
		 * If provided, exposes a Forget this device button. The callback is
		 * the destructive primitive (typically the workspace bundle's
		 * `wipe()`). The popover confirms with the user, awaits the
		 * callback, then reloads the page; reload after wipe is universal
		 * in this context so the component owns it rather than asking
		 * every caller to remember.
		 */
		onForgetDevice?: () => void | Promise<void>;
	};

	let { auth, collaboration, syncNoun, onForgetDevice }: AccountPopoverProps =
		$props();

	let syncStatus = $state<SyncStatus>();
	let popoverOpen = $state(false);
	let forgettingDevice = $state(false);
	const isSignedIn = $derived(auth.state.status === 'signed-in');
	const accountCacheKey = $derived(
		auth.state.status === 'signed-out' ? null : auth.state.ownerId,
	);
	const profile = createQuery(
		() => ({
			queryKey: ['account-profile', accountCacheKey],
			queryFn: async (): Promise<AccountProfile> => {
				const response = await auth.fetch('/api/session');
				if (!response.ok) {
					throw new Error(`Failed to load account (${response.status}).`);
				}
				return (await response.json()) as AccountProfile;
			},
			enabled: auth.state.status !== 'signed-out',
			staleTime: Infinity,
		}),
		() => accountProfileQueryClient,
	);
	const accountLabel = $derived(
		profile.data?.user.email ?? (profile.error ? 'Offline' : 'Loading...'),
	);
	const signOut = createResultMutation(
		() => ({
			mutationFn: () => auth.signOut(),
			onMutate: () => {
				popoverOpen = false;
			},
			onError: (error) => {
				toastOnError(error, 'Failed to sign out');
			},
		}),
		() => accountProfileQueryClient,
	);
	const startSignIn = createResultMutation(
		() => ({
			mutationFn: () => auth.startSignIn(),
		}),
		() => accountProfileQueryClient,
	);

	$effect(() => {
		if (!collaboration) {
			syncStatus = undefined;
			return;
		}
		syncStatus = collaboration.status;
		const unsubscribe = collaboration.onStatusChange((status) => {
			syncStatus = status;
		});
		return unsubscribe;
	});

	/**
	 * Tooltip string for the trigger pill, derived from sync phase + auth.
	 */
	function getSyncTooltip(
		s: SyncStatus | undefined,
		isAuthenticated: boolean,
	): string {
		if (!s) return isAuthenticated ? 'Account' : 'Sign in';
		if (!isAuthenticated) return 'Sign in to sync across devices';
		switch (s.phase) {
			case 'connected':
				return 'Connected';
			case 'connecting':
				if (s.retries > 0) return `Reconnecting (retry ${s.retries})…`;
				return 'Connecting…';
			case 'offline':
				return 'Offline. Click to reconnect';
			case 'failed':
				return 'Authentication failed. Click to reconnect';
		}
	}

	const tooltip = $derived(getSyncTooltip(syncStatus, isSignedIn));

	function forgetDevice() {
		if (!onForgetDevice) return;
		popoverOpen = false;
		confirmationDialog.open({
			title: 'Forget this device?',
			description: 'This deletes local data for this account on this device.',
			confirm: { text: 'Forget device', variant: 'destructive' },
			onConfirm: async () => {
				forgettingDevice = true;
				try {
					await onForgetDevice();
					window.location.reload();
				} catch (error) {
					toast.error('Failed to forget this device', {
						description: extractErrorMessage(error),
					});
				} finally {
					forgettingDevice = false;
				}
			},
		});
	}
</script>

<Popover.Root bind:open={popoverOpen}>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="ghost" size="icon-sm" {tooltip}>
				<div class="relative">
					{#if signOut.isPending}
						<LoaderCircle class="size-4 animate-spin" />
					{:else if !isSignedIn}
						<CloudOff class="size-4 text-muted-foreground" />
					{:else if !syncStatus}
						<User class="size-4" />
					{:else if syncStatus.phase === 'connected'}
						<Cloud class="size-4" />
					{:else if syncStatus.phase === 'connecting'}
						<LoaderCircle class="size-4 animate-spin" />
					{:else}
						<CloudOff class="size-4 text-destructive" />
					{/if}
					{#if !isSignedIn}
						<span
							class="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary"
						></span>
					{/if}
				</div>
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-80 p-0" align="end">
		{#if auth.state.status === 'signed-in'}
			<div class="p-4 space-y-3">
				<div class="space-y-1">
					<p class="text-sm font-medium">{accountLabel}</p>
				</div>
				{#if collaboration && syncStatus}
					<div class="border-t pt-3 space-y-1">
						<p class="text-xs text-muted-foreground">
							Sync:
							{({
								connected: 'Connected',
								connecting: 'Connecting…',
								offline: 'Offline',
								failed: 'Failed',
							} satisfies Record<SyncStatus['phase'], string>)[syncStatus.phase]}
						</p>
					</div>
				{/if}
				<div class="border-t pt-3 flex gap-2">
					{#if collaboration && syncStatus?.phase !== 'connected'}
						<Button
							variant="outline"
							size="sm"
							class="flex-1"
							onclick={() => collaboration.reconnect()}
						>
							<RefreshCw class="size-3.5" />
							Reconnect
						</Button>
					{/if}
					<Button
						variant="ghost"
						size="sm"
						class="flex-1"
						onclick={() => signOut.mutate()}
					>
						<LogOut class="size-3.5" />
						Sign out
					</Button>
				</div>
				{#if onForgetDevice}
					<div class="border-t pt-3">
						<Button
							variant="ghost"
							size="sm"
							class="w-full justify-start text-destructive hover:text-destructive"
							onclick={forgetDevice}
							disabled={forgettingDevice}
						>
							{#if forgettingDevice}
								<LoaderCircle class="size-3.5 animate-spin" />
							{:else}
								<DatabaseZap class="size-3.5" />
							{/if}
							Forget this device
						</Button>
					</div>
				{/if}
			</div>
		{:else}
			<div class="p-4 space-y-3">
				<div class="space-y-1">
					<p class="text-sm font-medium">Sign in</p>
					<p class="text-xs text-muted-foreground">
						Sign in to sync your {syncNoun} across devices.
					</p>
				</div>
				{#if startSignIn.error}
					<p class="text-xs text-destructive">{startSignIn.error.message}</p>
				{/if}
				<Button
					class="w-full"
					onclick={() => startSignIn.mutate()}
					disabled={startSignIn.isPending}
				>
					{#if startSignIn.isPending}
						<LoaderCircle class="size-4 animate-spin" />
						Signing in…
					{:else if auth.state.status === 'reauth-required'}
						Reconnect
					{:else}
						Sign in with Epicenter
					{/if}
				</Button>
			</div>
		{/if}
	</Popover.Content>
</Popover.Root>
