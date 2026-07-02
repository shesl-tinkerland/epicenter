<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Dialog from '@epicenter/ui/dialog';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import type { SignInMigrationState } from './create-sign-in-migration.svelte';

	/**
	 * Shared Add / Delete / Keep dialog for the first-sign-in migration. Mount
	 * once in the app's root layout beside the other global dialogs; the words
	 * come from the migration state's `summary` and `note`, which the app
	 * configured in `createSignInMigration`.
	 */
	let { migration }: { migration: SignInMigrationState } = $props();
</script>

<Dialog.Root bind:open={migration.open}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title>Add your local data to your account?</Dialog.Title>
			<Dialog.Description>
				This device has {migration.summary} saved locally, outside your
				account. Add them to sync across your devices, or remove them from this
				device.{#if migration.note}{' '}{migration.note}{/if}
			</Dialog.Description>
		</Dialog.Header>

		<Dialog.Footer class="gap-2 sm:justify-between">
			<Button
				variant="ghost"
				disabled={migration.isBusy}
				onclick={() => migration.keepForNow()}
			>
				Keep for now
			</Button>
			<div class="flex gap-2">
				<Button
					variant="outline"
					disabled={migration.isBusy}
					onclick={() => migration.deleteFromDevice()}
				>
					{#if migration.phase === 'deleting'}
						<LoaderCircle class="size-4 animate-spin" />
					{/if}
					Delete from device
				</Button>
				<Button
					disabled={migration.isBusy}
					onclick={() => migration.addToAccount()}
				>
					{#if migration.phase === 'adding'}
						<LoaderCircle class="size-4 animate-spin" />
					{/if}
					Add to my account
				</Button>
			</div>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
