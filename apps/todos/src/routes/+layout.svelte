<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { ModeWatcher } from 'mode-watcher';
	import '@epicenter/ui/app.css';

	let { children } = $props();
</script>

<svelte:head><title>To-do's</title></svelte:head>

<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>

<Toaster offset={16} closeButton />
<ConfirmationDialog />
<ModeWatcher defaultMode="dark" track={false} />
