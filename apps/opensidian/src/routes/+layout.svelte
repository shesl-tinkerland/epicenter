<script lang="ts">
	import { PersistenceGate } from '@epicenter/svelte/persistence-gate';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import { ModeWatcher } from 'mode-watcher';
	import { auth, opensidian } from '$lib/opensidian/client';
	import '../app.css';

	let { children } = $props();
</script>

<ConfirmationDialog />
<Toaster />
<ModeWatcher />

<PersistenceGate
	{auth}
	whenReady={opensidian.idb.whenLoaded}
	wipe={() => opensidian.wipe()}
>
	{@render children()}
</PersistenceGate>
