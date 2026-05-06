<script lang="ts">
	import {
		CommandPalette,
		type CommandPaletteItem,
	} from '@epicenter/ui/command-palette';
	import { Kbd } from '@epicenter/ui/kbd';
	import * as Resizable from '@epicenter/ui/resizable';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import type { Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { getSignedInSession } from '$lib/signed-in-session';
	import AppHeader from './AppHeader.svelte';
	import EntriesSidebar from './EntriesSidebar.svelte';

	let { children }: { children: Snippet } = $props();
	const { fuji, entries } = getSignedInSession();

	function createEntry() {
		const { id } = fuji.actions.entries.create({});
		goto(`/entries/${id}`);
	}

	function flushPendingEdits() {
		if (
			document.visibilityState === 'hidden' &&
			document.activeElement instanceof HTMLElement
		) {
			document.activeElement.blur();
		}
	}

	let paletteOpen = $state(false);
	let paletteQuery = $state('');

	const paletteItems = $derived.by((): CommandPaletteItem[] => {
		if (!paletteOpen) return [];
		return entries.active.map((entry) => ({
			id: entry.id,
			label: entry.title || 'Untitled',
			description: entry.subtitle || undefined,
			icon: FileTextIcon,
			keywords: [...entry.tags, ...entry.type],
			group: entry.type.length > 0 ? entry.type[0] : 'Uncategorized',
			onSelect: () => goto(`/entries/${entry.id}`),
		}));
	});
</script>

<svelte:document onvisibilitychange={flushPendingEdits} />

<svelte:window
	onpagehide={flushPendingEdits}
	onkeydown={(event) => {
		const isInputFocused =
			event.target instanceof HTMLInputElement ||
			event.target instanceof HTMLTextAreaElement ||
			(event.target instanceof HTMLElement && event.target.isContentEditable);

		if (event.key === 'k' && event.metaKey) {
			event.preventDefault();
			paletteOpen = !paletteOpen;
			return;
		}

		if (event.key === 'n' && event.metaKey) {
			event.preventDefault();
			createEntry();
			return;
		}

		if (event.key === 'Escape' && !isInputFocused && page.url.pathname !== '/') {
			event.preventDefault();
			goto('/');
		}
	}}
/>

<Tooltip.Provider>
	<div class="flex h-screen flex-col">
		<AppHeader onOpenSearch={() => (paletteOpen = true)} />
		<Resizable.PaneGroup direction="horizontal" class="flex-1">
			<Resizable.Pane defaultSize={20} minSize={15} maxSize={40}>
				<EntriesSidebar />
			</Resizable.Pane>
			<Resizable.Handle withHandle />
			<Resizable.Pane defaultSize={80}> {@render children()} </Resizable.Pane>
		</Resizable.PaneGroup>
		<div
			class="flex h-7 shrink-0 items-center gap-3 border-t bg-background px-3 text-xs text-muted-foreground"
		>
			<span
				>{entries.active.length}
				{entries.active.length === 1 ? 'entry' : 'entries'}</span
			>
			<div class="ml-auto flex items-center gap-1.5">
				<span class="flex items-center gap-1"> Search <Kbd>⌘K</Kbd> </span>
			</div>
		</div>
	</div>
</Tooltip.Provider>

<CommandPalette
	items={paletteItems}
	bind:open={paletteOpen}
	bind:value={paletteQuery}
	placeholder="Search entries..."
	emptyMessage="No entries found."
	title="Search Entries"
	description="Search entries by title, subtitle, tags, or type"
/>
