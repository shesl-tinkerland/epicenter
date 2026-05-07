<script lang="ts">
	import type { AuthClient } from '@epicenter/auth-svelte';
	import { Button } from '@epicenter/ui/button';
	import * as Popover from '@epicenter/ui/popover';
	import { toastOnError } from '@epicenter/ui/sonner';
	import type { SyncAttachment, SyncStatus } from '@epicenter/workspace';
	import Cloud from '@lucide/svelte/icons/cloud';
	import CloudOff from '@lucide/svelte/icons/cloud-off';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import LogOut from '@lucide/svelte/icons/log-out';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { AuthForm } from '../auth-form/index.js';

	/**
	 * Shared account popover.
	 *
	 * Renders sync status from a `SyncAttachment` (the concrete `attachSync`
	 * return type exposed as `workspace.sync`) alongside auth identity,
	 * reconnect, and sign-out.
	 */
	type AccountPopoverProps = {
		/** The auth client from `createCookieAuth()` or `createBearerAuth()`. */
		auth: AuthClient;
		/**
		 * The workspace's `attachSync` result, typically `workspace.sync`.
		 * Stable for this component's lifetime. Remount when switching workspaces.
		 */
		sync: SyncAttachment;
		/** Noun describing what gets synced, e.g. "tabs" or "notes". */
		syncNoun: string;
		/** Handler called when the user clicks "Continue with Google". */
		onSocialSignIn: () => Promise<{ error: { message: string } | null }>;
	};

	let { auth, sync, syncNoun, onSocialSignIn }: AccountPopoverProps = $props();

	let syncStatus = $state<SyncStatus>({ phase: 'offline' });
	let popoverOpen = $state(false);
	let signingOut = $state(false);
	const isSignedIn = $derived(auth.state.status === 'signed-in');

	$effect(() => {
		syncStatus = sync.status;
		const unsubscribe = sync.onStatusChange((status) => {
			syncStatus = status;
		});
		return unsubscribe;
	});

	/**
	 * Tooltip string for the trigger pill, derived from sync phase + auth.
	 */
	function getSyncTooltip(s: SyncStatus, isAuthenticated: boolean): string {
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

	async function signOut() {
		popoverOpen = false;
		signingOut = true;
		try {
			const result = await auth.signOut();
			if (result.error) toastOnError(result, 'Failed to sign out');
		} finally {
			signingOut = false;
		}
	}
</script>

<Popover.Root bind:open={popoverOpen}>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="ghost" size="icon-sm" {tooltip}>
				<div class="relative">
					{#if signingOut}
						<LoaderCircle class="size-4 animate-spin" />
					{:else if !isSignedIn}
						<CloudOff class="size-4 text-muted-foreground" />
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
					<p class="text-sm font-medium">{auth.state.identity.user.name}</p>
					<p class="text-xs text-muted-foreground">
						{auth.state.identity.user.email}
					</p>
				</div>
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
				<div class="border-t pt-3 flex gap-2">
					{#if syncStatus.phase !== 'connected'}
						<Button
							variant="outline"
							size="sm"
							class="flex-1"
							onclick={() => sync.reconnect()}
						>
							<RefreshCw class="size-3.5" />
							Reconnect
						</Button>
					{/if}
					<Button variant="ghost" size="sm" class="flex-1" onclick={signOut}>
						<LogOut class="size-3.5" />
						Sign out
					</Button>
				</div>
			</div>
		{:else}
			<div class="flex items-center justify-center p-4">
				<AuthForm {auth} {syncNoun} {onSocialSignIn} />
			</div>
		{/if}
	</Popover.Content>
</Popover.Root>
