<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Kbd from '@epicenter/ui/kbd';
	import * as Modal from '@epicenter/ui/modal';
	import AlertTriangle from '@lucide/svelte/icons/alert-triangle';
	import HelpCircle from '@lucide/svelte/icons/help-circle';
	import {
		CommandOrAlt,
		CommandOrControl,
		KEYBOARD_EVENT_SUPPORTED_KEY_SECTIONS,
		OPTION_DEAD_KEYS,
	} from '$lib/constants/keyboard';
	import { os } from '#platform/os';
	import type { Modifier } from '$lib/tauri/commands';
	import { keyBindingToLabel } from '$lib/utils/key-binding';

	let { type }: { type: 'local' | 'global' } = $props();
	let dialogOpen = $state(false);

	const isLocal = $derived(type === 'local');

	// Local (browser) examples: lowercase, character-space.
	const LOCAL_EXAMPLES = [
		' ',
		`${CommandOrControl.toLowerCase()}+a`,
		`${CommandOrControl.toLowerCase()}+shift+p`,
		`${CommandOrAlt.toLowerCase()}+s`,
		'f5',
		`control+${CommandOrAlt.toLowerCase()}+delete`,
	];

	// Global (desktop, rdev) binds in physical-key space as a held gesture. Labels
	// render through the same helper the recorder uses, so the guide always
	// matches what gets stored. Examples mirror the shipped defaults.
	const GLOBAL_MODIFIERS: Modifier[] = ['ctrl', 'alt', 'shift', 'meta', 'fn'];
	const modifierLabel = (modifier: Modifier) =>
		keyBindingToLabel({ modifiers: [modifier], keys: [] }, os.isApple);
	const GLOBAL_SHAPES = [
		{
			binding: os.isApple
				? { modifiers: ['fn'], keys: [] }
				: { modifiers: ['ctrl', 'meta'], keys: [] },
			desc: 'a modifier held on its own (the push-to-talk default)',
		},
		{
			binding: os.isApple
				? { modifiers: ['meta', 'shift'], keys: ['space'] }
				: { modifiers: ['ctrl', 'shift'], keys: ['space'] },
			desc: 'a modifier chord plus a key (the toggle default)',
		},
	] satisfies { binding: { modifiers: Modifier[]; keys: string[] }; desc: string }[];
</script>

<Button
	variant="ghost"
	size="icon"
	class="size-6"
	onclick={() => (dialogOpen = true)}
	tooltip="Click for shortcut format guide"
>
	<HelpCircle class="size-4" />
	<span class="sr-only">Shortcut format help</span>
</Button>

<Modal.Root bind:open={dialogOpen}>
	<Modal.Content
		class="sm:max-w-3xl md:max-h-[calc(100dvh-2rem)] md:grid-rows-[auto_minmax(0,1fr)_auto] md:overflow-hidden"
	>
		<Modal.Header>
			<Modal.Title>
				{isLocal ? 'Local' : 'Global'}
				Shortcut Format Guide
			</Modal.Title>
			<Modal.Description>
				Learn how to format keyboard shortcuts for
				{isLocal ? 'in-app' : 'system-wide'}
				use.
			</Modal.Description>
		</Modal.Header>

		<div class="flex flex-col gap-4 md:min-h-0 md:overflow-y-auto md:pr-2">
			{#if isLocal}
				<!-- Quick format summary -->
				<div class="rounded-lg bg-muted p-4">
					<p class="text-sm">
						Use <code class="font-mono text-xs">modifier+key</code> format or just
						<code class="font-mono text-xs">key</code>
						for single keys.
					</p>
					<p class="text-sm text-muted-foreground mt-1">
						Any key from your keyboard can be used (lowercase). Below are common
						examples:
					</p>
				</div>

				<!-- Two-column flex layout -->
				<div class="flex flex-col sm:flex-row sm:divide-x">
					<!-- Left column: Modifiers -->
					<div class="sm:pr-4">
						<h4 class="text-sm font-semibold mb-1">Modifiers</h4>
						<p class="text-xs text-muted-foreground mb-2">Hold with other keys</p>
						<div class="flex flex-wrap sm:flex-col gap-1">
							{#each KEYBOARD_EVENT_SUPPORTED_KEY_SECTIONS[0].keys as modifier}
								<Kbd.Root>{modifier}</Kbd.Root>
							{/each}
						</div>
					</div>

					<!-- Right column: All other keys -->
					<div class="flex-1 sm:pl-4">
						<div class="flex flex-col gap-4">
							{#each KEYBOARD_EVENT_SUPPORTED_KEY_SECTIONS.slice(1) as section}
								<div>
									<h4 class="text-sm font-semibold mb-1">{section.title}</h4>
									<p class="text-xs text-muted-foreground mb-2">
										{section.description}
									</p>
									<div class="flex flex-wrap gap-1">
										{#each section.keys as key}
											<Kbd.Root>{key}</Kbd.Root>
										{/each}
									</div>
								</div>
							{/each}
						</div>
					</div>
				</div>

				<!-- Examples -->
				<div>
					<h4 class="mb-2 font-medium">Examples</h4>
					<div class="space-y-2 rounded-lg border p-3">
						{#each LOCAL_EXAMPLES as example}
							<code class="block text-sm">{example}</code>
						{/each}
					</div>
				</div>

				{#if os.isApple}
					<Alert.Root variant="warning">
						<AlertTriangle class="size-4" />
						<Alert.Title>Apple Keyboard Option Key Limitations</Alert.Title>
						<Alert.Description class="space-y-2">
							<p>
								On Apple keyboards, certain Option (Alt) key combinations act as
								"dead keys" that don't register properly when recording:
							</p>
							<div class="flex flex-wrap gap-1 my-2">
								{#each OPTION_DEAD_KEYS as key}
									<Kbd.Root>Option + {key.toUpperCase()}</Kbd.Root>
								{/each}
							</div>
							<p class="font-medium">Workarounds:</p>
							<ul class="list-disc list-inside space-y-1 ml-2">
								<li>Record in reverse: Press the letter first, then Option</li>
								<li>Edit manually: Type "alt+e" instead of recording</li>
							</ul>
						</Alert.Description>
					</Alert.Root>
				{/if}
			{:else}
				<!-- Global (rdev) summary -->
				<div class="rounded-lg bg-muted p-4">
					<p class="text-sm">
						Global shortcuts are held gestures that fire system-wide, so they
						work from any app and can use keys the old shortcuts could not: the
						Fn key or a modifier held on its own. Give every gesture a modifier
						or Fn so it cannot fire on an ordinary keypress, and give each one its
						own keys: a key bound to one gesture (like push-to-talk's Fn) cannot
						be part of another.
					</p>
				</div>

				<!-- Modifiers -->
				<div>
					<h4 class="text-sm font-semibold mb-1">Modifiers</h4>
					<p class="text-xs text-muted-foreground mb-2">
						Combine with a key, or hold one on its own.
					</p>
					<div class="flex flex-wrap gap-1">
						{#each GLOBAL_MODIFIERS as modifier}
							<Kbd.Root>{modifierLabel(modifier)}</Kbd.Root>
						{/each}
					</div>
				</div>

				<!-- The three shapes -->
				<div>
					<h4 class="text-sm font-semibold mb-1">Two kinds of shortcut</h4>
					<div class="space-y-2">
						{#each GLOBAL_SHAPES as shape}
							<div class="flex items-center gap-2">
								<Kbd.Root>{keyBindingToLabel(shape.binding, os.isApple)}</Kbd.Root>
								<span class="text-xs text-muted-foreground">{shape.desc}</span>
							</div>
						{/each}
					</div>
				</div>

				<p class="text-xs text-muted-foreground">
					Keys match by physical position, so on a non-US layout the label may
					differ from the printed character. Record a gesture by pressing it, or
					type one like <code class="font-mono text-xs">fn+space</code> or
					<code class="font-mono text-xs">ctrl+meta</code>.
				</p>
			{/if}
		</div>

		<Modal.Footer>
			<Button onclick={() => (dialogOpen = false)}>Close</Button>
		</Modal.Footer>
	</Modal.Content>
</Modal.Root>
