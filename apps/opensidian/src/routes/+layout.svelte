<script lang="ts">
	import { WorkspaceGate } from '@epicenter/svelte/workspace-gate';
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

<WorkspaceGate
	pending={opensidian.idb.whenLoaded}
	forgetDevice={() => opensidian.wipe()}
	signOut={() => auth.signOut()}
>
	{@render children()}
</WorkspaceGate>
