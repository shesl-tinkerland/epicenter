<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Item from '@epicenter/ui/item';
	import InfoIcon from '@lucide/svelte/icons/info';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import WandSparklesIcon from '@lucide/svelte/icons/wand-sparkles';
	import { accessibilityGuide } from '$lib/components/MacosAccessibilityGuideDialog.svelte';
	import { dictationCapability } from '$lib/state/dictation-capability.svelte';
	import { recordings } from '$lib/state/recordings.svelte';

	// One declarative view over the dictation capability Rust owns, in three
	// registers that differ in kind, not just wording:
	//   - broken: a stale grant left the global tap dead. A real FAULT, so an amber
	//     glyph, a `role="alert"`, and a primary action.
	//   - untrusted (first grant): never granted. An optional UPGRADE, not a wall.
	//     Dictation already works through the shortcut and clipboard, so the glyph
	//     is calm and the action is a quiet outline button.
	//   - unsupported (Wayland): a platform FACT, nothing to grant. An info glyph
	//     pointing at the mic that still works; no action.
	// All three share one slim outlined `Item` (icon · message · trailing action)
	// at the same size, so backgrounds and padding stay uniform and only the glyph
	// and the action carry the register. None is dismissable: each
	// clears itself when the capability flips, and a quiet banner never needs
	// hiding. The detailed steps live in the guide dialog the action opens. The
	// branch order is load-bearing: `broken` is caught before the plain untrusted
	// case (`needsAccessibility` covers both).
	//
	// The optional pitch waits for the first transcript. It is a pitch, not a
	// problem, and "hold a key to talk" only means something once you have pressed
	// once and watched a transcript land. Holding it back keeps a brand-new home
	// clean and lets the pitch arrive when it is finally relevant. Derived from the
	// recordings that already exist, so it costs no dismissal flag. Breakage and
	// the Wayland limit are never gated: those are immediate.
	const hasDictatedOnce = $derived(
		recordings.sorted.some((r) => r.transcript.trim()),
	);
	const isFirstGrant = $derived(
		dictationCapability.needsAccessibility &&
			!dictationCapability.isStale &&
			hasDictatedOnce,
	);
</script>

{#if dictationCapability.isStale}
	<Item.Root variant="outline" size="sm" class="w-full" role="alert">
		<Item.Media>
			<TriangleAlertIcon class="text-warning size-4" aria-hidden="true" />
		</Item.Media>
		<Item.Content>
			<Item.Title>Your global shortcut isn't firing</Item.Title>
			<Item.Description>
				Re-granting macOS Accessibility usually fixes it. Until then, transcripts
				go to your clipboard.
			</Item.Description>
		</Item.Content>
		<Item.Actions>
			<Button size="sm" onclick={() => accessibilityGuide.open()}>
				Show me how
			</Button>
		</Item.Actions>
	</Item.Root>
{:else if isFirstGrant}
	<Item.Root variant="outline" size="sm" class="w-full">
		<Item.Media>
			<WandSparklesIcon class="size-4" aria-hidden="true" />
		</Item.Media>
		<Item.Content>
			<Item.Title>Hold a key to talk, paste hands-free</Item.Title>
			<Item.Description>
				Your shortcut already copies transcripts to your clipboard.
			</Item.Description>
		</Item.Content>
		<Item.Actions>
			<Button
				size="sm"
				variant="outline"
				onclick={() => accessibilityGuide.open()}
			>
				Show me how
			</Button>
		</Item.Actions>
	</Item.Root>
{:else if dictationCapability.isUnsupported}
	<Item.Root variant="outline" size="sm" class="w-full">
		<Item.Media>
			<InfoIcon class="size-4" aria-hidden="true" />
		</Item.Media>
		<Item.Content>
			<Item.Title>Global shortcuts need an X11 session</Item.Title>
			<Item.Description>
				On Wayland, Whispering can't tap your keyboard globally. Click the mic to
				record instead.
			</Item.Description>
		</Item.Content>
	</Item.Root>
{/if}
