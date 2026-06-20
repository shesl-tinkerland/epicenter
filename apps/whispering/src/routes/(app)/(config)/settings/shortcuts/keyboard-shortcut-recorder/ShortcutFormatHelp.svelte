<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Kbd from '@epicenter/ui/kbd';
	import * as Modal from '@epicenter/ui/modal';
	import HelpCircle from '@lucide/svelte/icons/help-circle';
	import { os } from '#platform/os';
	import type { Modifier } from '$lib/tauri/commands';
	import { keyBindingToLabel } from '$lib/utils/key-binding';

	let { type }: { type: 'local' | 'global' } = $props();
	let dialogOpen = $state(false);

	const isLocal = $derived(type === 'local');

	// Both tiers bind in physical-key space and render through the same label
	// helper the recorder uses, so the guide always matches what gets stored.
	const modifierLabel = (modifier: Modifier) =>
		keyBindingToLabel({ modifiers: [modifier], keys: [] }, os.isApple);

	type Shape = { binding: { modifiers: Modifier[]; keys: string[] }; desc: string };

	// In-app (browser) shortcuts fire while the window is focused. The browser
	// cannot see Fn, so the modifier palette stops at the four it exposes; a
	// binding may be a chord or a single key on its own.
	const LOCAL_MODIFIERS: Modifier[] = ['ctrl', 'alt', 'shift', 'meta'];
	const LOCAL_SHAPES = [
		{
			binding: { modifiers: [], keys: ['space'] },
			desc: 'a single key on its own (the toggle default)',
		},
		{
			binding: {
				modifiers: os.isApple ? ['meta', 'shift'] : ['ctrl', 'shift'],
				keys: ['keyP'],
			},
			desc: 'a modifier chord plus a key',
		},
	] satisfies Shape[];

	// Global (desktop, rdev) binds the same way but adds the holds the native tap
	// can see: Fn and a modifier on its own. Examples mirror the shipped defaults.
	const GLOBAL_MODIFIERS: Modifier[] = ['ctrl', 'alt', 'shift', 'meta', 'fn'];
	const GLOBAL_SHAPES = [
		{
			binding: os.isApple
				? { modifiers: ['fn'], keys: [] }
				: { modifiers: ['ctrl', 'meta'], keys: [] },
			desc: 'a single key held on its own (the recording default)',
		},
		{
			binding: os.isApple
				? { modifiers: ['meta'], keys: ['dot'] }
				: { modifiers: ['ctrl', 'shift'], keys: ['dot'] },
			desc: 'a modifier chord plus a key (the cancel default)',
		},
	] satisfies Shape[];
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
				<!-- In-app summary -->
				<div class="rounded-lg bg-muted p-4">
					<p class="text-sm">
						In-app shortcuts fire while the Whispering window is focused. Use a
						modifier plus a key, or a single key on its own.
					</p>
				</div>

				<!-- Modifiers -->
				<div>
					<h4 class="text-sm font-semibold mb-1">Modifiers</h4>
					<p class="text-xs text-muted-foreground mb-2">
						Combine with a key.
					</p>
					<div class="flex flex-wrap gap-1">
						{#each LOCAL_MODIFIERS as modifier}
							<Kbd.Root>{modifierLabel(modifier)}</Kbd.Root>
						{/each}
					</div>
				</div>

				<!-- The two shapes -->
				<div>
					<h4 class="text-sm font-semibold mb-1">Two kinds of shortcut</h4>
					<div class="space-y-2">
						{#each LOCAL_SHAPES as shape}
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
					type one like <code class="font-mono text-xs">ctrl+shift+a</code> or
					<code class="font-mono text-xs">space</code>.
				</p>
			{:else}
				<!-- Global (rdev) summary -->
				<div class="rounded-lg bg-muted p-4">
					<p class="text-sm">
						Global shortcuts are held gestures that fire system-wide, so they
						work from any app and can use keys the old shortcuts could not: the
						Fn key or a modifier held on its own. Give every gesture a modifier
						or Fn so it cannot fire on an ordinary keypress, and give each one its
						own keys: a key bound to one gesture (like the recording key's Fn)
						cannot be part of another.
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
					type one like <code class="font-mono text-xs">fn</code> or
					<code class="font-mono text-xs">ctrl+meta</code>.
				</p>
			{/if}
		</div>

		<Modal.Footer>
			<Button onclick={() => (dialogOpen = false)}>Close</Button>
		</Modal.Footer>
	</Modal.Content>
</Modal.Root>
