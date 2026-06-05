<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Dialog from '@epicenter/ui/dialog';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { signInMigration } from './sign-in-migration.svelte';

	const count = $derived(signInMigration.recordingCount);
</script>

<Dialog.Root bind:open={signInMigration.open}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title>Add your recordings to this account?</Dialog.Title>
			<Dialog.Description>
				This device has {count}
				recording{count === 1 ? '' : 's'} saved locally, outside your account.
				Add them to sync across your devices, or remove them from this device.
				Audio files stay where they were recorded.
			</Dialog.Description>
		</Dialog.Header>

		<Dialog.Footer class="gap-2 sm:justify-between">
			<Button
				variant="ghost"
				disabled={signInMigration.isBusy}
				onclick={() => signInMigration.keepForNow()}
			>
				Keep for now
			</Button>
			<div class="flex gap-2">
				<Button
					variant="outline"
					disabled={signInMigration.isBusy}
					onclick={() => signInMigration.deleteFromDevice()}
				>
					{#if signInMigration.phase === 'deleting'}
						<LoaderCircle class="size-4 animate-spin" />
					{/if}
					Delete from device
				</Button>
				<Button
					disabled={signInMigration.isBusy}
					onclick={() => signInMigration.addToAccount()}
				>
					{#if signInMigration.phase === 'adding'}
						<LoaderCircle class="size-4 animate-spin" />
					{/if}
					Add to my account
				</Button>
			</div>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
