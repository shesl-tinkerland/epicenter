<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import { openVaults } from '$lib/open-vaults.svelte';
</script>

<Empty.Root class="flex-1 border-0">
	<Empty.Media variant="icon"><FolderOpenIcon /></Empty.Media>
	<Empty.Title>Open a vault</Empty.Title>
	<Empty.Description>
		Choose a directory of markdown. Matter reads the whole vault at once, so references resolve
		across its tables: each immediate child folder is one table. A single table folder opens on its
		own too.
	</Empty.Description>
	<Empty.Content>
		<Button onclick={openVaults.open}>
			<FolderOpenIcon />
			Open vault
		</Button>
	</Empty.Content>
</Empty.Root>
