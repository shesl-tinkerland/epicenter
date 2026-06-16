<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import { Separator } from '@epicenter/ui/separator';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import { report } from '$lib/report';
	import { os } from '#platform/os';
	import { tauri } from '#platform/tauri';
	import { whispering } from '#platform/whispering';
	import type { Command } from '$lib/commands';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import type { KeyBinding } from '$lib/tauri/commands';
	import { createPressedKeys } from '$lib/utils/createPressedKeys.svelte';
	import { keyBindingToLabel } from '$lib/utils/key-binding';
	import {
		getGlobalShortcutKey,
		getLocalShortcutKey,
		resetGlobalShortcuts,
		resetLocalShortcuts,
	} from '$lib/operations/shortcuts';
	import GlobalKeyboardShortcutRecorder from './keyboard-shortcut-recorder/GlobalKeyboardShortcutRecorder.svelte';
	import LocalKeyboardShortcutRecorder from './keyboard-shortcut-recorder/LocalKeyboardShortcutRecorder.svelte';
	import ShortcutFormatHelp from './keyboard-shortcut-recorder/ShortcutFormatHelp.svelte';
	import ShortcutTable from './keyboard-shortcut-recorder/ShortcutTable.svelte';

	// One shortcut system per platform: the desktop app uses global (system-wide,
	// rdev) shortcuts; the browser uses in-app (focused-tab) shortcuts. They never
	// coexist, so this page shows whichever one this platform has.

	// Browser-only: the local recorder records shortcuts from window keydown. On
	// desktop the global recorder records through the rdev backend instead, so
	// this (and its window keydown listener) is never created there. Its presence
	// also marks local mode for the template below.
	const pressedKeys = tauri
		? undefined
		: createPressedKeys({
				onUnsupportedKey: (key) => {
					report.info({
						title: 'Unsupported key',
						description: `The key "${key}" is not supported. Please try a different key.`,
					});
				},
			});

	/** The definition default for a local shortcut, formatted for display. */
	function localDefault(commandId: Command['id']): string | null {
		return whispering.settings.getDefault(getLocalShortcutKey(commandId)) ?? null;
	}

	/** The definition default for a global shortcut, formatted for display. */
	function globalDefault(commandId: Command['id']): string | null {
		// Stored bindings are validated as plain strings; the IPC `KeyBinding` types
		// `keys` as the Rust `Key` vocabulary, so the cast bridges that boundary.
		const binding = deviceConfig.getDefault(
			getGlobalShortcutKey(commandId),
		) as KeyBinding | null;
		return binding ? keyBindingToLabel(binding, os.isApple) : null;
	}

	function reset() {
		if (tauri) resetGlobalShortcuts();
		else resetLocalShortcuts();
		report.success({
			title: 'Shortcuts reset',
			description: 'All shortcuts have been reset to defaults.',
		});
	}
</script>

<svelte:head> <title>Keyboard Shortcuts - Whispering</title> </svelte:head>

<section>
	<div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
		<SectionHeader.Root>
			<div class="flex items-center gap-2">
				<SectionHeader.Title level={2} class="text-xl tracking-tight sm:text-2xl">
					{tauri ? 'Global Shortcuts' : 'In-App Shortcuts'}
				</SectionHeader.Title>
				<ShortcutFormatHelp type={tauri ? 'global' : 'local'} />
			</div>
			<SectionHeader.Description>
				{#if tauri}
					System-wide gestures that fire from anywhere, even when Whispering is
					not focused. Hold the Fn key or a modifier chord. Each gesture needs
					its own keys, so the key you use for push-to-talk cannot be part of
					another shortcut.
				{:else}
					Shortcuts that trigger while the Whispering tab is focused.
				{/if}
			</SectionHeader.Description>
		</SectionHeader.Root>
		<Button variant="outline" size="sm" onclick={reset} class="shrink-0">
			<RotateCcw class="size-4" />
			Reset to defaults
		</Button>
	</div>

	<Separator class="my-6" />

	{#if tauri}
		{@const t = tauri}
		<ShortcutTable>
			{#snippet row(command)}
				{@const def = globalDefault(command.id)}
				<GlobalKeyboardShortcutRecorder
					{command}
					placeholder={def ? `Default: ${def}` : 'Set shortcut'}
					tauri={t}
				/>
			{/snippet}
		</ShortcutTable>
	{:else if pressedKeys}
		<ShortcutTable>
			{#snippet row(command)}
				{@const def = localDefault(command.id)}
				<LocalKeyboardShortcutRecorder
					{command}
					placeholder={def ? `Default: ${def}` : 'Set shortcut'}
					{pressedKeys}
				/>
			{/snippet}
		</ShortcutTable>
	{/if}
</section>
