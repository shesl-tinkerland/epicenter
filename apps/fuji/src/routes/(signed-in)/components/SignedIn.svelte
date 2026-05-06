<script lang="ts">
	import { WorkspaceGate } from '@epicenter/svelte/workspace-gate';
	import { getOrCreateInstallationId } from '@epicenter/workspace';
	import { onDestroy } from 'svelte';
	import { auth } from '$lib/auth';
	import { openFuji } from '../fuji/browser';
	import { setSignedIn } from '../signed-in';
	import { createEntriesState, setEntriesState } from '../state/entries.svelte';

	let { children } = $props();

	// Type-narrowing assertion. The (signed-in)/+layout.svelte parent already
	// gates on `status === 'signed-in'`, so this throw is unreachable in
	// practice; it exists so TypeScript narrows auth.state.identity below.
	if (auth.state.status !== 'signed-in') {
		throw new Error('<SignedIn> mounted outside signed-in scope');
	}

	const initialIdentity = auth.state.identity;
	// Snapshot identity into $state so the gate keeps serving the last-known
	// identity to children during the sign-out tear-down frame, rather than
	// reading auth.state.identity live (which would crash once status flips).
	let identity = $state(initialIdentity);

	const fuji = openFuji({
		identity: initialIdentity,
		peer: {
			id: getOrCreateInstallationId(localStorage),
			name: 'Fuji',
			platform: 'web',
		},
		bearerToken: () => auth.bearerToken,
	});

	const entriesState = createEntriesState(fuji);
	setEntriesState(entriesState);

	$effect(() => {
		if (auth.state.status === 'signed-in') {
			identity = auth.state.identity;
			fuji.encryption.applyKeys(auth.state.identity.encryptionKeys);
		}
	});

	onDestroy(() => {
		entriesState[Symbol.dispose]();
		fuji[Symbol.dispose]();
	});

	setSignedIn({
		get identity() {
			return identity;
		},
		get fuji() {
			return fuji;
		},
	});
</script>

<WorkspaceGate
	pending={fuji.idb.whenLoaded}
	onSignOut={() => auth.signOut()}
>
	{@render children?.()}
</WorkspaceGate>
