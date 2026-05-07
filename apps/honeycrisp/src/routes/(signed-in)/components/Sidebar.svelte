<script lang="ts">
	import { AccountPopover } from '@epicenter/svelte/account-popover';
	import * as Collapsible from '@epicenter/ui/collapsible';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import { auth } from '$lib/auth';
	import { getSignedInSession } from '$lib/session.svelte';
	import FolderMenuItem from '../components/FolderMenuItem.svelte';

	const signedIn = getSignedInSession();

	async function forgetHoneycrispDevice(): Promise<void> {
		await signedIn.honeycrisp.wipe();
		window.location.reload();
	}
</script>

<Sidebar.Root>
	<Sidebar.Header>
		<div class="flex items-center justify-between px-2 py-1">
			<span class="text-sm font-semibold">Honeycrisp</span>
			<div class="flex items-center gap-1">
				<AccountPopover
					{auth}
					sync={signedIn.honeycrisp.sync}
					syncNoun="notes"
					onForgetDevice={forgetHoneycrispDevice}
					onSocialSignIn={() =>
						auth.signInWithSocialRedirect({
							provider: 'google',
							callbackURL: window.location.origin,
						})}
				/>
				<Sidebar.Trigger />
			</div>
		</div>
		<div class="px-2 pb-1">
			<Sidebar.Input
				placeholder="Search notes…"
				value={signedIn.state.view.searchQuery}
				oninput={(e) => signedIn.state.view.setSearchQuery(e.currentTarget.value)}
			/>
		</div>
	</Sidebar.Header>

	<Sidebar.Content>
		<Sidebar.Group>
			<Sidebar.GroupContent>
				<Sidebar.Menu>
					<Sidebar.MenuItem>
						<Sidebar.MenuButton
							isActive={signedIn.state.view.selectedFolderId === null && !signedIn.state.view.isRecentlyDeletedView}
							onclick={() => signedIn.state.view.selectFolder(null)}
						>
							<FileTextIcon class="size-4" />
							<span>All Notes</span>
							<span class="ml-auto text-xs text-muted-foreground">
								{signedIn.state.notes.all.length}
							</span>
						</Sidebar.MenuButton>
					</Sidebar.MenuItem>
					<Sidebar.MenuItem>
						<Sidebar.MenuButton
							isActive={signedIn.state.view.isRecentlyDeletedView && signedIn.state.view.selectedFolderId === null}
							onclick={() => signedIn.state.view.selectRecentlyDeleted()}
						>
							<TrashIcon class="size-4" />
							<span>Recently Deleted</span>
							{#if signedIn.state.notes.deleted.length > 0}
								<span class="ml-auto text-xs text-muted-foreground">
									{signedIn.state.notes.deleted.length}
								</span>
							{/if}
						</Sidebar.MenuButton>
					</Sidebar.MenuItem>
				</Sidebar.Menu>
			</Sidebar.GroupContent>
		</Sidebar.Group>

		<Collapsible.Root open>
			<Sidebar.Group>
				<Collapsible.Trigger>
					<Sidebar.GroupLabel>Folders</Sidebar.GroupLabel>
				</Collapsible.Trigger>
				<Sidebar.GroupAction
					title="New Folder"
					onclick={() => signedIn.state.folders.create()}
				>
					<PlusIcon />
					<span class="sr-only">New Folder</span>
				</Sidebar.GroupAction>
				<Collapsible.Content>
					<Sidebar.GroupContent>
						<Sidebar.Menu>
							{#each signedIn.state.folders.all as folder (folder.id)}
								<FolderMenuItem {folder} />
							{:else}
								<Sidebar.MenuItem>
									<span class="text-muted-foreground px-2 py-1 text-xs">
										No folders yet
									</span>
								</Sidebar.MenuItem>
							{/each}
						</Sidebar.Menu>
					</Sidebar.GroupContent>
				</Collapsible.Content>
			</Sidebar.Group>
		</Collapsible.Root>
	</Sidebar.Content>

	<Sidebar.Rail />
</Sidebar.Root>
