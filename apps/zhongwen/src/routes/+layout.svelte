<script lang="ts">
	import '../app.css';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { ModeWatcher } from 'mode-watcher';

	let { children } = $props();
</script>

<Toaster />
<ConfirmationDialog />
<ModeWatcher />
<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>
