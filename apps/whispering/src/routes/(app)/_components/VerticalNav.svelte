<script lang="ts">
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { useSidebar } from '@epicenter/ui/sidebar';
	import Database from '@lucide/svelte/icons/database';
	import Minimize2Icon from '@lucide/svelte/icons/minimize-2';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import SunIcon from '@lucide/svelte/icons/sun';
	import { toggleMode } from 'mode-watcher';
	import { page } from '$app/state';
	import { GithubIcon } from '$lib/components/icons';
	import { NAV_ITEMS } from './nav-items';
	import { tauri } from '#platform/tauri';
	import { auth } from '#platform/auth';
	import { whispering } from '#platform/whispering';
	import { AccountPopover } from '@epicenter/svelte/account-popover';
	import MigrationDialog from '$lib/migration/MigrationDialog.svelte';
	import { migrationDialog } from '$lib/migration/migration-dialog.svelte';
	import { recordingActive } from '$lib/state/recording-active.svelte';

	const shouldShowMigrationButton = $derived(
		import.meta.env.DEV || migrationDialog.isPending,
	);

	const sidebar = useSidebar();
</script>

<Sidebar.Root collapsible="icon">
	<Sidebar.Header>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<Sidebar.MenuButton
					size="lg"
					class="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
				>
					{#snippet child({ props })}
						<button {...props} onclick={sidebar.toggle}>
							<div
								class="bg-sidebar-primary text-sidebar-primary-foreground flex size-8 items-center justify-center rounded-lg"
							>
								<span class="text-lg">🎙️</span>
							</div>
							<div
								class="grid flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden"
							>
								<span class="truncate font-semibold">Whispering</span>
								<span class="truncate text-xs text-muted-foreground"
									>Speech to text</span
								>
							</div>
						</button>
					{/snippet}
				</Sidebar.MenuButton>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Header>

	<Sidebar.Content>
		<!-- Navigation Group -->
		<Sidebar.Group>
			<Sidebar.GroupLabel>Navigation</Sidebar.GroupLabel>
			<Sidebar.GroupContent>
				<Sidebar.Menu>
					{#each NAV_ITEMS as item}
						<Sidebar.MenuItem>
							<Sidebar.MenuButton isActive={item.isActive(page.url.pathname)}>
								{#snippet child({ props })}
									{@const Icon = item.icon}
									<a href={item.href} {...props}>
										<Icon />
										<span>{item.label}</span>
									</a>
								{/snippet}
							</Sidebar.MenuButton>
						</Sidebar.MenuItem>
					{/each}
				</Sidebar.Menu>
			</Sidebar.GroupContent>
		</Sidebar.Group>
	</Sidebar.Content>

	<Sidebar.Footer>
		<Sidebar.Menu>
			<!-- Account / sync (route-independent: visible on the bare home page) -->
			<Sidebar.MenuItem>
				<div class="flex items-center px-1.5 py-1">
					<AccountPopover
						{auth}
						collaboration={whispering.collaboration}
						syncNoun="recordings"
						disabledReason={recordingActive.current
							? 'Stop recording to change your account'
							: undefined}
					/>
				</div>
			</Sidebar.MenuItem>

			<!-- Toggle dark mode -->
			<Sidebar.MenuItem>
				<Sidebar.MenuButton>
					{#snippet child({ props })}
						<button onclick={toggleMode} {...props}>
							<SunIcon
								class="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0"
							/>
							<MoonIcon
								class="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100"
							/>
							<span>Toggle theme</span>
						</button>
					{/snippet}
				</Sidebar.MenuButton>
			</Sidebar.MenuItem>

			<!-- GitHub link -->
			<Sidebar.MenuItem>
				<Sidebar.MenuButton>
					{#snippet child({ props })}
						<a
							href="https://github.com/EpicenterHQ/epicenter"
							target="_blank"
							rel="noopener noreferrer"
							{...props}
						>
							<GithubIcon />
							<span>GitHub</span>
						</a>
					{/snippet}
				</Sidebar.MenuButton>
			</Sidebar.MenuItem>

			<!-- Database Migration (desktop only, when data exists) -->
			{#if shouldShowMigrationButton}
				<Sidebar.MenuItem>
					<Sidebar.MenuButton class="relative">
						{#snippet child({ props })}
							<MigrationDialog>
								{#snippet trigger({ props: dialogProps })}
									<button {...props} {...dialogProps}>
										<Database />
										<span>Database Migration</span>
										<span
											class="absolute right-2 top-2 size-2 rounded-full bg-warning before:absolute before:left-0 before:top-0 before:h-full before:w-full before:rounded-full before:bg-warning/50 before:animate-ping"
										></span>
									</button>
								{/snippet}
							</MigrationDialog>
						{/snippet}
					</Sidebar.MenuButton>
				</Sidebar.MenuItem>
			{/if}

			<!-- Minimize (desktop only) -->
			{#if tauri}
				<Sidebar.MenuItem>
					<Sidebar.MenuButton>
						{#snippet child({ props })}
							<button
								onclick={async () => {
								const { getCurrentWindow, LogicalSize } = await import('@tauri-apps/api/window');
								getCurrentWindow().setSize(new LogicalSize(72, 84));
							}}
								{...props}
							>
								<Minimize2Icon />
								<span>Minimize</span>
							</button>
						{/snippet}
					</Sidebar.MenuButton>
				</Sidebar.MenuItem>
			{/if}
		</Sidebar.Menu>
	</Sidebar.Footer>

	<Sidebar.Rail />
</Sidebar.Root>
