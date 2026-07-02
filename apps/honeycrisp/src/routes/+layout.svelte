<script lang="ts">
	import { SignInMigrationDialog } from '@epicenter/app-shell/sign-in-migration';
	import { WorkspaceGate } from '@epicenter/app-shell/workspace-gate';
	import { reloadOnOwnerChange } from '@epicenter/svelte/auth';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { ModeWatcher } from 'mode-watcher';
	import { onMount } from 'svelte';
	import { auth } from '#platform/auth';
	import { honeycrisp } from '$lib/honeycrisp';
	import { signInMigration } from '$lib/migration/sign-in-migration';
	import '@epicenter/ui/app.css';

	let { children } = $props();

	// Option A (ADR-0088): the doc is picked once at boot (connectLocalFirst,
	// inside `openHoneycrispBrowser`); an owner-identity change reloads so the
	// next boot rebuilds the right doc.
	onMount(() => reloadOnOwnerChange(auth));

	// Signed-in only: prompt to migrate this device's local notes into the
	// account (no-op when signed out or when there is no local data). Fire and
	// forget: `signInMigration.check()` owns its own once-per-boot guard.
	onMount(() => {
		void signInMigration.check();
	});
</script>

<svelte:head><title>Honeycrisp</title></svelte:head>

<WorkspaceGate pending={honeycrisp.whenReady} onSignOut={() => auth.signOut()}>
	<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>
</WorkspaceGate>

<Toaster offset={16} closeButton />
<ConfirmationDialog />
<SignInMigrationDialog migration={signInMigration} />
<ModeWatcher defaultMode="dark" track={false} />
